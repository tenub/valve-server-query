const dns = require('dns');
const { createSocket } = require('dgram');
const EventEmitter = require('events');
const util = require('util');
const bzip = require('seek-bzip');
const { Uint64LE } = require('int64-buffer');
const { createLogger, transports } = require('winston');

const utils = require('./lib/utils');
const servers = require('./.servers.js');

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
    this.sendInfoPacket = this.sendInfoPacket.bind(this);
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
      dns.resolve(hostname, (err, records) => {
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
    await Promise.all(this.connections.map(this.sendInfoPacket));
  }

  handleSocketError(err) {
    this.emit('error', err);
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
    const headerType = packet.readInt(4);

    if (headerType === -1) { // simple response format
      const headerInfo = packet.readInt(1);

      if (headerInfo === 0x49) { // standard info response
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

        this.emit('info', data);

        this.connections[connectionIndex].info = data;
      } else if (headerInfo === 0x6D) { // obsolete GoldSource response
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

        this.emit('info', data);

        this.connections[connectionIndex].info = data;
      } else {
        this.emit('error', new Error(`Expected a valid info header value of "0x49" or "0x6D" but got "${headerInfo}.`));
      return false;
      }
    } else if (headerType === -2) { // multi-packet response format

    } else {
      this.emit('error', new Error(`Expected a valid response header value of "-1" or "-2" but got "${headerType}.`));
      return false;
    }

    if (this.connections.every(({ info }) => info)) {
      this.emit('done', this.connections);

      const [, endstamp] = process.hrtime();
      const time = (endstamp - this.timestamp) / 10e9;
      logger.info(`query time: ${utils.round(time, 4)}s`);

      this.socket.close();
    }
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

  async sendInfoPacket({ host, port }) {
    const packet = new RequestPacket('info');

    try {
      await this.sendPacket(packet, port, host);
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
