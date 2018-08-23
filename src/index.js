const dns = require('dns');
const { createSocket } = require('dgram');
const EventEmitter = require('events');
const bzip = require('seek-bzip');
const debug = require('debug')('query');

const RequestPacket = require('./request-packet');
const ResponsePacket = require('./response-packet');

/**
 * @class ServerQuery
 * @param {Object[]} connections Array of servers to query
 * @param {string} connections[].host Server hostname or IPv4 address
 * @param {number} connections[].port Server port
 * @param {Object} options Custom options
 * @param {number} options.timeout Socket timeout in milliseconds
 */
class ServerQuery extends EventEmitter {
  constructor(connections, options) {
    super();

    /**
     * Options reference merged with default options
     *
     * @type {Object}
     * @property {number} timeout Timeout for socket connection
     */
    this.options = {
      timeout: 2000,
      ...options
    };

    // Bind this class to its event handlers
    this._handleSocketError = this._handleSocketError.bind(this);
    this._handleSocketMessage = this._handleSocketMessage.bind(this);
    this._socketTimeout = this._socketTimeout.bind(this);

    /**
     * Socket reference for when the connect method is called
     *
     * @type {?Object}
     * @default null
     */
    this.socket = null;

    /**
     * Socket timeout reference, set just before sending initial requests
     *
     * @type {?number}
     * @default null
     */
    this.timeout = null;

    /**
     * Connections array reference
     *
     * @type {Object[]}
     * @default connections
     */
    this.connections = connections;
  }

  /**
   * Set up a socket to send and receive requests
   *
   * @returns {this} this
   */
  async connect() {
    try {
      await this._connect();
    } catch (err) {
      this.emit('error', err);
    }

    return this;
  }

  /**
   * Send initial info request to each connection. Further requests are sent on completion of each preceding request until all queries are fulfilled. If no connections are present null is returned.
   *
   * @returns {?this} this
   */
  async query() {
    if (!this.connections) {
      this.socket.close();
      this.emit('done', null);

      return null;
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

        this._requestInfo(this.connections[i], i);
      }
    } catch (err) {
      this.emit('error', err);
    }

    return this;
  }

  /**
   * Event handler for socket errors that emits an error if the socket receives one
   * @param {Error} err Incoming error
   * @returns {Boolean} Always true
   */
  _handleSocketError(err) {
    this.emit('error', err);

    return true;
  }

  /**
   * Event handler for socket messages that parses query response packets from the remote host
   * @param {Buffer} msg Received data
   * @param {Object} rinfo Remote information
   * @param {string} rinfo.address Remote IPv4 address
   * @param {number} rinfo.port Remote port
   * @returns {Boolean} Whether the message was parsed
   */
  _handleSocketMessage(msg, { address, port } = {}) {
    if (!(msg instanceof Buffer) || !msg.length) {
      this.emit('error', new Error('Expected a valid response.'));

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
        const data = this._parseChallenge(packet);

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
   * Parse a packet from a split response. Store each packet in its corresponding connection and packet index
   * @param {ResponsePacket} packet Response packet
   * @param {number} connectionIndex Corresponding connection index
   * @returns {Buffer|Boolean} Combined response or false if not every packet has been collected yet
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
   * @typedef {Object} ResultInfo
   * @property {number} protocol Protocol version used by the server
   * @property {string} name Name of the server
   * @property {string} map Map the server has currently loaded
   * @property {string} folder Name of the folder containing the game files
   * @property {string} game Full name of the game
   * @property {number} id Steam Application ID of game
   * @property {number} players Number of players on the server
   * @property {number} maxplayers Maximum number of players the server reports it can hold
   * @property {number} bots Number of bots on the server
   * @property {string} type Indicates the type of server
   * @property {string} environment Indicates the operating system of the server
   * @property {Boolean} visibility  Indicates whether the server requires a password (public/private)
   * @property {Boolean} vac Specifies whether the server uses VAC (unsecured/secured)
   * @property {number} [mode] Indicates the game mode
   * @property {number} [witnesses] The number of witnesses necessary to have a player arrested
   * @property {number} [duration] Time (in seconds) before a player is arrested while being witnessed
   * @property {number} version Version of the game installed on the server
   * @property {number} [port] If present, this specifies which additional data fields will be included
   * @property {string} [steamid] The server's game port number
   * @property {Object} [spectator] Server's SteamID
   * @property {number} [spectator.port] Spectator port number for SourceTV
   * @property {string} [spectator.name] Name of the spectator server for SourceTV
   * @property {string} [keywords] Tags that describe the game according to the server
   * @property {string} [gameid] The server's 64-bit GameID
   */

  /**
   * Parse a packet as an info response
   * @param {ResponsePacket} packet Response packet
   * @returns {ResultInfo} data Resulting info object
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
   * @typedef {Object} ResultInfoObsolete
   * @property {string} address IP address and port of the server
   * @property {string} name Name of the server
   * @property {string} map Map the server has currently loaded
   * @property {string} folder Name of the folder containing the game files
   * @property {string} game Full name of the game
   * @property {number} players Number of players on the server
   * @property {number} maxplayers Maximum number of players the server reports it can hold
   * @property {number} protocol Protocol version used by the server
   * @property {string} type Indicates the type of server
   * @property {string} environment Indicates the operating system of the server
   * @property {Boolean} visibility Indicates whether the server requires a password (public/private)
   * @property {Boolean|Object} mod Indicates whether the game is a mod
   * @property {string} mod.link URL to mod website
   * @property {string} mod.downloadlink URL to download the mod
   * @property {number} mod.version Version of mod installed on server
   * @property {number} mod.size Space (in bytes) the mod takes up
   * @property {number} mod.type Indicates the type of mod
   * @property {number} mod.dll Indicates whether mod uses its own DLL
   * @property {Boolean} vac Specifies whether the server uses VAC (unsecured/secured)
   * @property {number} bots Number of bots on the server
   */

  /**
   * Parse a packet as an obsolete info response
   * @param {ResponsePacket} packet Response packet
   * @returns {ResultInfoObsolete} data Resulting info object
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
   * @typedef {Object} ResultPlayer
   * @property {number} index Index of player chunk starting from 0
   * @property {string} name Name of the player
   * @property {number} score Player's score
   * @property {number} duration Time (in seconds) player has been connected to the server
   * @property {number} [deaths] Player's deaths
   * @property {number} [money] Player's money
   */

  /**
   * Parse a packet as a player response. A valid app id is needed to work correctly which can be obtained from an info query result
   * @param {ResponsePacket} packet Response packet
   * @param {number} appId Application id of Steam game
   * @returns {ResultPlayer[]} data Resulting players array
   */
  _parsePlayer(packet, appId) {
    const players = [];

    let numplayers = packet.readInt(1);

    if (appId == 2400) {
      while (numplayers > 0 && packet.index < packet.data.length) {
        const index = packet.readInt(1);
        const name = packet.readString();
        const score = packet.readInt(4);
        const duration = packet.readFloat();
        const deaths = packet.readInt(4);
        const money = packet.readInt(4);

        players.push({
          index,
          name,
          score,
          duration,
          deaths,
          money
        });

        numplayers -= 1;
      }
    } else {
      while (numplayers > 0 && packet.index < packet.data.length) {
        const index = packet.readInt(1);
        const name = packet.readString();
        const score = packet.readInt(4);
        const duration = packet.readFloat();

        players.push({
          index,
          name,
          score,
          duration
        });

        numplayers -= 1;
      }
    }

    const data = { players };

    return data;
  }

  /**
   * @typedef {Object} ResultRule
   * @property {string} name Name of the rule
   * @property {string} value Value of the rule
   */

  /**
   * Parse a packet as a rules response
   * @param {ResponsePacket} packet Response packet
   * @returns {ResultRule[]} data Resulting rules array
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
   * @param {ResponsePacket} packet Response packet
   * @returns {number} challenge Resulting challenge number
   */
  _parseChallenge(packet) {
    const challenge = packet.readInt(4);

    return challenge;
  }

  /**
   * Send an info request packet
   *
   * @param {Object} connection Remote connection
   * @param {string} connection.host Remote hostname or IPv4 address
   * @param {number} connection.port Remote port
   * @param {number} connection index
   * @returns {Boolean} Whether the request was successful
   */
  async _requestInfo({ host, port }, i) {
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
   *
   * @param {Object} connection Remote connection
   * @param {string} connection.host Remote hostname or IPv4 address
   * @param {number} connection.port Remote port
   * @param {number} connection._challengePlayer Current challenge number for the player query
   * @param {number} connection index
   * @returns {Boolean} Whether the request was successful
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
   *
   * @param {Object} connection Remote connection
   * @param {string} connection.host Remote hostname or IPv4 address
   * @param {number} connection.port Remote port
   * @param {number} connection._challengeRules Current challenge number for the rules query
   * @param {number} connection index
   * @returns {Boolean} Whether the request was successful
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
   * Send a ping request packet. Some servers may not respond depending on the game
   *
   * @param {Object} connection Remote connection
   * @param {string} connection.host Remote hostname or IPv4 address
   * @param {number} connection.port Remote port
   * @param {number} connection index
   * @returns {Boolean} Whether the request was successful
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
   * Send a challenge request packet (deprecated)
   *
   * @param {Object} connection Remote connection
   * @param {string} connection.host Remote hostname or IPv4 address
   * @param {number} connection.port Remote port
   * @param {number} connection._challengePlayer Current challenge number for the player query
   * @param {number} connection index
   * @returns {Boolean} Whether the request was successful
   */
  async _requestChallenge({ host, port, _challengePlayer }, i) {
    const packet = new RequestPacket(_challengePlayer ? 'rules' : 'player');

    try {
      await this._sendPacket(packet, port, host);
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  /**
   * Create a socket connection and store a reference. This is a promise wrapper for built-in methods
   * @returns {Promise}
   */
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
   * Resolve a hostname to an IPv4 address. This is a promise wrapper for the built-in method
   * @param {string} hostname Remote host name
   * @returns {Promise}
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
   * Send a request packet. This is a promise wrapper for the built-in method
   * @param {RequestPacket} packet Request packet
   * @param {number} port Remote port
   * @param {string} address Remote IPv4 address
   * @returns {Promise}
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
   * Close the socket connection for the timeout. Emit any results if they were received
   * @returns {Boolean} Always true
   */
  _socketTimeout() {
    this.socket.close();
    this.emit('done', this.connections);

    return true;
  }

  /**
   * Check if every request has been fulfilled for each connection. Called at the end of each request chain (the ping message handler)
   * @returns {Boolean} Whether all requests have been fulfilled
   */
  _checkIfDone() {
    debug('_checkIfDone => this.connections: %o', this.connections);

    if (this.connections.every(({ info, player, rules, ping }) => (
      info && player && rules && ping
    ))) {
      this.emit('done', this.connections);

      clearTimeout(this.timeout);

      this.socket.close();

      return true;
    }

    return false;
  }
}

module.exports = ServerQuery;
