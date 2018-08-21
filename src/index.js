const dns = require('dns');
const { createSocket } = require('dgram');
const EventEmitter = require('events');
const bzip = require('seek-bzip');
const debug = require('debug')('query');

const RequestPacket = require('./request-packet');
const ResponsePacket = require('./response-packet');

class ServerQuery extends EventEmitter {
  constructor(connections, options) {
    super();

    this.options = {
      timeout: 2000,
      ...options
    };

    // bind this class to its event handlers
    this._handleSocketError = this._handleSocketError.bind(this);
    this._handleSocketMessage = this._handleSocketMessage.bind(this);
    this._socketTimeout = this._socketTimeout.bind(this);

    // declare a socket for when the connect method is called
    this.socket = null;

    // declare a socket timeout
    // this is set just before sending initial requests
    this.timeout = null;

    // store a reference of the connections array
    this.connections = connections;
  }

  /**
   * Set up a socket to send and receive requests
   */
  async connect() {
    await this._connect();

    return this;
  }

  /**
   * Send initial info request to each connection
   * Further requests are sent on completion of each preceding request
   * Until all queries are fulfilled
   */
  async query() {
    if (!this.connections) {
      this.socket.close();
      this.emit('done', false);
      return false;
    }

    try {
      // start the socket timeout
      this.timeout = setTimeout(this._socketTimeout, this.options.timeout);

      // send out an initial info request
      for (let i = 0, l = this.connections.length; i < l; i++) {
        const addresses = await this._resolveHost(this.connections[i].host);

        debug(`query => addresses: ${addresses}`);

        const [address] = addresses;
        this.connections[i] = { ...this.connections[i], host: address };

        this.requestInfo(this.connections[i], i);
      }
    } catch (err) {
      this.emit('error', err);
    }

    return this;
  }

  /**
   * Emit an error if the socket receives one
   */
  _handleSocketError(err) {
    this.emit('error', err);
  }

  /**
   * Parse query response packets from the remote host
   */
  _handleSocketMessage(msg, { address, port }) {
    if (!msg.length) {
      this.emit('error', new Error('Expected a response.'));

      return false;
    }

    const connectionIndex = this.connections.findIndex((connection) => {
      return connection.host == address && connection.port == port;
    });

    if (connectionIndex < 0) {
      this.emit('error', new Error('Could not find a matching connection to received message.'));

      return false;
    }

    const connection = this.connections[connectionIndex];

    debug(`_handleSocketMessage => msg: %o`, msg);

    let packet = new ResponsePacket(msg);

    // read response type
    const headerFormat = packet.readInt(4);

    switch (headerFormat) {
      case -1: // simple response format
        break;

      // multi-packet response format
      case -2: {
        // update packet reference
        const result = this._parseMultiPacket(packet, connectionIndex);

        if (!result) {
          return true;
        }

        packet.data = result;
        packet.index = 0;

        debug(`_handleSocketMessage => packet.data: %o`, packet.data);

        break;
      }

      default:
        this.emit('error', new Error(`Expected a valid response header but got "${headerFormat}.`));

        return false;
    }

    const headerType = packet.readInt(1);

    switch (headerType) {
      // standard info response
      case 0x49: {
        const data = this._parseInfo(packet);

        this.emit('info', data);
        this.connections[connectionIndex].info = data;

        // get challenge for player
        this._requestChallenge(connection, connectionIndex);

        break;
      }

      // obsolete GoldSource info response
      case 0x6D: {
        const data = this._parseInfoObsolete(packet);

        this.emit('info', data);
        this.connections[connectionIndex].info = data;

        // get challenge for player
        this._requestChallenge(connection, connectionIndex);

        break;
      }

      // player response
      case 0x44: {
        const appId =connection.info.id;
        const data = this._parsePlayer(packet, appId);

        debug(`_handleSocketMessage => appId: ${appId}`);

        this.emit('player', data);
        this.connections[connectionIndex].player = data;

        // get challenge for rules
        this._requestChallenge(connection, connectionIndex);

        break;
      }

      // rules response
      case 0x45: {
        const data = this._parseRules(packet);

        this.emit('rules', data);
        this.connections[connectionIndex].rules = data;

        this._requestPing(connection, connectionIndex);

        break;
      }

      // ping response
      case 0x6A: {
        const [, endTime] = process.hrtime();
        const startTime = this.connections[connectionIndex]._timestamp;
        const data = (endTime - startTime) / 10e6;

        this.emit('ping', data);
        this.connections[connectionIndex].ping = data;

        this._checkIfDone();

        break;
      }

      // challenge response
      case 0x41: {
        const data = this.parseChallenge(packet);

        this.emit('challenge', data);

        if (!this.connections[connectionIndex]._challengePlayer) {
          this.connections[connectionIndex]._challengePlayer = data;
          this._requestPlayer(connection, connectionIndex);
        } else {
          this.connections[connectionIndex]._challengeRules = data;
          this._requestRules(connection, connectionIndex);
        }

        break;
      }

      // unknown response
      default:
        this.emit('error', new Error(`Expected a valid type header but got "${headerType}".`));

        return false;
    }

    return true;
  }

  /**
   * Parse a packet from a split response
   * Store each packet in its corresponding connection and index
   * Return the fully combined response as a single buffer
   */
  _parseMultiPacket(packet, connectionIndex) {
    const connection = this.connections[connectionIndex] || {};

    const id = packet.readInt(4);

    let packetTotal;
    let packetId;

    // handle multi-packet goldsource engine response
    // goldsource games have an appid that is less than 200
    if (connection.info.id < 200) {
      // read upper 4 bits and lower 4 bits of current byte separately
      const packetNumber = packet.readInt(1);
      packetId = (packetNumber >> 4) & 0x0F;
      packetTotal = packetNumber & 0x0F;

      debug(`_handleSocketMessage => packetId: %i, packetTotal: %i`, packetId, packetTotal);
    } else {
      // handle multi-packet source engine response
      const compressed = (id & 0xFF) >> 7;

      debug(`_handleSocketMessage => compressed: %i`, compressed);

      packetTotal = packet.readInt(1);
      packetId = packet.readInt(1);

      debug(`_handleSocketMessage => packetId: %i, packetTotal: %i`, packetId, packetTotal);

      const appId = connection.info.id;
      const protocol = connection.info.protocol;

      if (!(protocol == 7 && (appId == 215 || appId == 17550 || appId == 17700 || appId == 240))) {
        const packetSize = packet.readInt(2);

        debug(`_handleSocketMessage => packetSize: %i`, packetSize);
      }

      // compression data is only present in the first packet
      if (packetId == 0 && compressed) {
        const size = packet.readInt(4);
        const checksum = packet.readInt(4);

        debug(`_handleSocketMessage => size: %i, checksum: %i`, size, checksum);

        this.connections[connectionIndex]._compression = { size, checksum };
      }
    }

    // read unneeded simple header in multi-packet
    if (packetId == 0) {
      packet.readInt(4);
    }

    if (!connection._packets) {
      this.connections[connectionIndex]._packets = new Array(packetTotal);
    }

    this.connections[connectionIndex]._packets[packetId] = packet.data.slice(packet.index);

    const numDefinedPackets = connection._packets.filter(packet => packet).length;

    // all packets have been received
    if (numDefinedPackets == packetTotal) {
      // merge packet array
      const data = Buffer.concat(this.connections[connectionIndex]._packets);

      // decompress multi-packet data if needed
      const compression = this.connections[connectionIndex]._compression;

      return compression ? bzip.decode(data, compression.size) : data;
    }

    return false;
  }

  /**
   * Parse a packet as an info response
   */
  _parseInfo(packet) {
    const protocol = packet.readInt(1);
    const name = packet.readString();
    const map = packet.readString();
    const folder = packet.readString();
    const game = packet.readString();
    const id = packet.readInt(2);
    const players = packet.readInt(1);
    const maxplayers = packet.readInt(1);
    const bots = packet.readInt(1);
    const type = packet.readChar();
    const environment = packet.readChar();
    const visibility = packet.readInt(1);
    const vac = packet.readInt(1);

    let data = {
      protocol,
      name,
      map,
      folder,
      game,
      id,
      players,
      maxplayers,
      bots,
      type,
      environment,
      visibility,
      vac
    };

    // The Ship
    if (id == 2400) {
      const mode = packet.readInt(1);
      const witnesses = packet.readInt(1);
      const duration = packet.readInt(1);

      data.mode = mode;
      data.witnesses = witnesses;
      data.duration = duration;
    }

    const version = packet.readString();
    data.version = version;

    const flag = packet.readInt(1);

    if (flag & 0x80) {
      const port = packet.readInt(2);
      data.port = port;
    }

    if (flag & 0x10) {
      const steamid = packet.readInt(8).toString();
      data.steamid = steamid;
    }

    if (flag & 0x40) {
      const spectator = {
        port: packet.readInt(2),
        name: packet.readString()
      };

      data.spectator = spectator;
    }

    if (flag & 0x20) {
      const keywords = packet.readString();
      data.keywords = keywords;
    }

    if (flag & 0x01) {
      const gameid = packet.readInt(8).toString();
      data.gameid = gameid;
    }

    return data;
  }

  /**
   * Parse a packet as an obsolete info response
   */
  _parseInfoObsolete(packet) {
    const address = packet.readString();
    const name = packet.readString();
    const map = packet.readString();
    const folder = packet.readString();
    const game = packet.readString();
    const players = packet.readInt(1);
    const maxplayers = packet.readInt(1);
    const protocol = packet.readInt(1);
    const type = packet.readChar();
    const environment = packet.readChar();
    const visibility = packet.readInt(1);
    const mod = packet.readInt(1);

    const data = {
      address,
      name,
      map,
      folder,
      game,
      players,
      maxplayers,
      protocol,
      type,
      environment,
      visibility,
      mod
    };

    if (data.mod == 1) {
      const mod = {
        link: packet.readString(),
        downloadlink: packet.readString()
      };

      packet.readInt(1); // null byte

      mod.version = packet.readInt(4);
      mod.size = packet.readInt(4);
      mod.type = packet.readInt(1);
      mod.dll = packet.readInt(1);

      data.mod = mod;
    }

    const vac = packet.readInt(1);
    const bots = packet.readInt(1);

    data.vac = vac;
    data.bots = bots;

    return data;
  }

  /**
   * Parse a packet as a player response
   * A valid app id is needed to work correctly
   * An info query result will contain the id
   */
  _parsePlayer(packet, appId) {
    const players = [];

    let numplayers = packet.readInt(1);

    if (appId == 2400) {
      while (numplayers > 0 && packet.index < packet.data.length) {
        players.push({
          index: packet.readInt(1),
          name: packet.readString(),
          score: packet.readInt(4),
          duration: packet.readFloat(),
          deaths: packet.readInt(4),
          money: packet.readInt(4)
        });

        numplayers -= 1;
      }
    } else {
      while (numplayers > 0 && packet.index < packet.data.length) {
        players.push({
          index: packet.readInt(1),
          name: packet.readString(),
          score: packet.readInt(4),
          duration: packet.readFloat()
        });

        numplayers -= 1;
      }
    }

    const data = { players };

    return data;
  }

  /**
   * Parse a packet as a rules response
   */
  _parseRules(packet) {
    const rules = [];

    let numrules = packet.readInt(2);

    while (numrules > 0 && packet.index < packet.data.length) {
      const name = packet.readString();
      const value = packet.readString();

      rules.push({ name, value });

      numrules -= 1;
    }

    const data = { rules };

    return data;
  }

  /**
   * Parse a packet as a challenge response
   */
  parseChallenge(packet) {
    const challenge = packet.readInt(4);

    return challenge;
  }

  /**
   * Send an info request packet
   */
  async requestInfo({ host, port }, i) {
    const packet = new RequestPacket('info');

    try {
      await this._sendPacket(packet, port, host);
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  /**
   * Send a player request packet
   */
  async _requestPlayer({ host, port, _challengePlayer }, i) {
    if (!_challengePlayer) {
      this.emit('error', new Error(`Connection index "${i}" is missing a player challenge.`));
    }

    debug(`_requestPlayer => challenge: ${_challengePlayer}`);

    const packet = new RequestPacket('player', _challengePlayer);

    try {
      await this._sendPacket(packet, port, host);
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  /**
   * Send a rules request packet
   */
  async _requestRules({ host, port, _challengeRules }, i) {
    if (!_challengeRules) {
      this.emit('error', new Error(`Connection index "${i}" is missing a rules challenge.`));
    }

    debug(`_requestRules => challenge: ${_challengeRules}`);

    const packet = new RequestPacket('rules', _challengeRules);

    try {
      await this._sendPacket(packet, port, host);
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  /**
   * Send a ping request packet
   * Some servers may not respond depending on the game
   */
  async _requestPing({ host, port }, i) {
    const packet = new RequestPacket('ping');

    try {
      const [, timestamp] = process.hrtime();
      this.connections[i]._timestamp = timestamp;

      await this._sendPacket(packet, port, host);

      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  /**
   * Send a challenge request packet
   * This is deprecated
   */
  async _requestChallenge({ host, port, _challengePlayer, _challengeRules }, i) {
    const packet = new RequestPacket(_challengePlayer ? 'rules' : 'player');

    try {
      await this._sendPacket(packet, port, host);
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  async _connect() {
    return new Promise((resolve) => {
      this.socket = createSocket('udp4');

      this.socket.on('error', this._handleSocketError);
      this.socket.on('message', this._handleSocketMessage);

      this.socket.bind(() => {
        return resolve();
      });
    });
  }

  /**
   * Resolve a hostname to an IPv4 address
   * Promise wrapper for built-in method
   */
  async _resolveHost(hostname) {
    return new Promise((resolve, reject) => {
      dns.resolve(hostname, 'A', (err, records) => {
        if (err) {
          return reject(err);
        }

        return resolve(records);
      })
    })
  }

  /**
   * Send a request packet
   * Promise wrapper for built-in method
   */
  async _sendPacket(packet, port, address) {
    return new Promise((resolve, reject) => {
      this.socket.send(packet, 0, packet.length, port, address, (err, bytes) => {
        if (err) {
          return reject(err);
        }

        return resolve(bytes);
      });
    });
  }

  /**
   * Close the socket connection for the timeout
   * Emit any results if they were received
   */
  _socketTimeout() {
    this.socket.close();
    this.emit('done', this.connections);
  }

  /**
   * Check if every request has been fulfilled for each connection
   * Called at the end of each request chain (the ping message handler)
   */
  _checkIfDone() {
    debug('_checkIfDone => this.connections: %o', this.connections);

    if (this.connections.every(({ info, player, rules, ping }) => (
      info && player && rules && ping
    ))) {
      this.emit('done', this.connections);

      clearTimeout(this.timeout);

      this.socket.close();
    }
  }
}

module.exports = ServerQuery;
