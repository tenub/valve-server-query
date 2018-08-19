const dns = require('dns');
const { createSocket } = require('dgram');
const EventEmitter = require('events');
const util = require('util');
const bzip = require('seek-bzip');
const { Uint64LE } = require('int64-buffer');
const { createLogger, transports } = require('winston');

const utils = require('./utils');
const servers = require('./servers');

const logger = createLogger({
  level: 'debug',
  transports: [
    new transports.Console()
  ]
});

class RequestPacket {
  constructor(type) {
    switch (type) {
      case 'info':
        return this.info();
      case 'player':
        return this.player();
      case 'rules':
        return this.rules();
      case 'challenge':
        return this.getchallenge();
      case 'ping':
        return this.ping();
    }
  }

  info() {
    const packet = Buffer.alloc(25);

    let index = packet.writeInt32LE(-1, 0);
    index = packet.writeUInt8(0x54, index);
    index += packet.write('Source Engine Query', index);
    index = packet.writeUInt8(0x00, index);

    return packet;
  }

  player(challenge = -1) {
    const packet = Buffer.alloc(9);

    let index = packet.writeInt32LE(-1, 0);
    index = packet.writeUInt8(0x55, index);
    index = packet.writeInt32LE(challenge, index);

    return packet;
  }

  rules(challenge = -1) {
    const packet = Buffer.alloc(9);

    let index = packet.writeInt32LE(-1, 0);
    index = packet.writeUInt8(0x56, index);
    index = packet.writeInt32LE(challenge, index);

    return packet;
  }

  getchallenge() {
    const packet = Buffer.alloc(5);

    let index = this.packet.writeInt32LE(-1, 0);
    index = packet.writeUInt8(0x57, index);

    return packet;
  }

  ping() {
    const packet = Buffer.alloc(5);

    let index = packet.writeInt32LE(-1, 0);
    index = packet.writeUInt8(0x69, index);

    return packet;
  }
}

class ResponsePacket {
  constructor(data) {
    this.data = data;
    this.index = 0;

    //this.readInt = this.readInt.bind(this);
  }

  readInt(bytes = 1) {
    const value = (
      bytes === 8 ?
        new Uint64LE(this.data, this.index) :
      bytes === 4 ?
        this.data.readInt32LE(this.index) :
      bytes === 2 ?
        this.data.readInt16LE(this.index) :
        this.data.readUInt8(this.index)
    );

    this.index += bytes;

    return value;
  }

  readFloat() {
    const value = this.data.readFloatLE(this.index);

    this.index += 4;

    return value;
  }

  readChar() {
    const chrCode = this.readInt(1);
    const chr = String.fromCharCode(chrCode);

    return chr;
  }

  readString() {
    const start = this.index;

    while (this.index < this.data.length) {
      if (this.readInt(1) === 0x00) {
        break;
      }
    }

    const value = this.data.slice(start, this.index - 1).toString();

    return value;
  }
}

class ServerQuery extends EventEmitter {
  constructor(connections, options = {}) {
    super();

    // bind this class to its methods
    // me: let's make a class
    // js: "d'oh!"
    this.handleSocketError = this.handleSocketError.bind(this);
    this.handleSocketMessage = this.handleSocketMessage.bind(this);
    this.sendRequests = this.sendRequests.bind(this);
    this.requestInfo = this.requestInfo.bind(this);
    this.sendPacket = this.sendPacket.bind(this);

    // save starting timestamp just before opening a socket connection
    const [, timestamp] = process.hrtime();
    this.timestamp = timestamp;

    // set up us our socket for sending requests and receiving responses
    this.socket = createSocket('udp4');

    this.socket.on('error', this.handleSocketError);
    this.socket.on('message', this.handleSocketMessage);

    this.socket.bind();

    // store a reference of the connections array
    this.connections = connections;

    // update connections with resolved addresses
    // send out query requests
    this.sendRequests();
  }

  async resolveHost(hostname) {
    return new Promise((resolve, reject) => {
      dns.resolve(hostname, 'A', (err, records) => {
        if (err) {
          return reject(err);
        }

        return resolve(records);
      })
    })
  }

  async resolveConnections() {
    const hostnames = this.connections.map(({ host }) => host);
    const addresses = await Promise.all(hostnames.map(this.resolveHost));

    this.connections = this.connections.map((connection, i) => {
      const [host] = addresses[i];
      return { ...connection, host };
    });
  }

  async sendRequests() {
    await this.resolveConnections();

    // send info query for each connection
    await Promise.all(this.connections.map(this.requestInfo));
  }

  handleSocketError(err) {
    this.emit('error', err);
  }

  parseInfo(packet) {
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
    if (id === 2400) {
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

  parseInfoObsolete(packet) {
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

    if (data.mod === 1) {
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

  parsePlayers(packet, flag = false) {
    const players = [];

    let numplayers = this.readInt(1);

    if (flag) {
      while (numplayers > 0 && this.index < this.data.length) {
        players.push({
          index: this.readInt(1),
          name: this.readString(),
          score: this.readInt(4),
          duration: this.readFloat(),
          deaths: this.readInt(4),
          money: this.readInt(4)
        });

        numplayers -= 1;
      }
    } else {
      while (numplayers > 0 && this.index < this.data.length) {
        players.push({
          index: this.readInt(1),
          name: this.readString(),
          score: this.readInt(4),
          duration: this.readFloat()
        });

        numplayers -= 1;
      }
    }

    const data = { players };

    return data;
  }

  parseRules(packet) {
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

  parseChallenge(packet) {
    const challenge = packet.readInt(4);
    const data = { challenge };

    return data;
  }

  parsePing(packet) {
    const ping = packet.readString();
    const data = { ping };

    return data;
  }

  handleSocketMessage(msg, { address, port }) {
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

    const packet = new ResponsePacket(msg);

    // read response type
    const headerFormat = packet.readInt(4);

    switch (headerFormat) {
      case -1: // simple response format
        break;
      case -2: // multi-packet response format
        break;
      default:
        this.emit('error', new Error(`Expected a valid response header but got "${headerFormat}.`));
        return false;
    }

    const headerType = packet.readInt(1);

    switch (headerType) {
      // challenge response
      case 0x41: {
        const data = this.parseChallenge(packet);
        this.emit('challenge', data);
        this.connections[connectionIndex].challenge = data;
        break;
      }

      // standard info response
      case 0x49: {
        const data = this.parseInfo(packet);
        this.emit('info', data);
        this.connections[connectionIndex].info = data;
        break;
      }

      // obsolete GoldSource info response
      case 0x6D: {
        const data = this.parseInfoObsolete(packet);
        this.emit('info', data);
        this.connections[connectionIndex].info = data;
        break;
      }

      // player response
      case 0x44: {
        const data = this.parsePlayer(packet);
        this.emit('player', data);
        this.connections[connectionIndex].players = data;
        break;
      }

      // rules response
      case 0x45: {
        const data = this.parseRules(packet);
        this.emit('rules', data);
        this.connections[connectionIndex].rules = data;
        break;
      }

      // unknown response
      default:
        this.emit('error', new Error(`Expected a valid type header but got "${headerType}".`));
        return false;
    }

    if (this.connections.every(({ info }) => info)) {
      this.emit('done', this.connections);

      const [, endstamp] = process.hrtime();
      const time = (endstamp - this.timestamp) / 10e9;
      logger.info(`query time: ${utils.round(time, 4)}s`);

      this.socket.close();
    }

    return true;
  }

  async sendPacket(packet, port, address) {
    return new Promise((resolve, reject) => {
      this.socket.send(packet, 0, packet.length, port, address, (err, bytes) => {
        if (err) {
          return reject(err);
        }

        return resolve(bytes);
      });
    });
  }

  async requestInfo({ host, port }, i) {
    const packet = new RequestPacket('info');

    try {
      this.connections[i]._type = 'info';
      await this.sendPacket(packet, port, host);
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  async requestPlayer({ host, port }, i) {
    const packet = new RequestPacket('player');

    try {
      this.connections[i]._type = 'player';
      await this.sendPacket(packet, port, host);
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }
}

const serverQuery = new ServerQuery(servers);

serverQuery.on('error', (err) => {
  console.error(err);
  process.exit(1);
});

serverQuery.on('done', (data) => {
  console.info(data);
});

serverQuery.on('info', (data) => {
  // info response
});

serverQuery.on('player', () => {
  // player response
});

serverQuery.on('rules', () => {
  // rules response
});

serverQuery.on('ping', () => {
  // ping response
});

serverQuery.on('challenge', () => {
  // challenge response
});
