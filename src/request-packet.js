class RequestPacket {
  constructor(type, challenge = -1) {
    this.data = null;
    this.index = 0;
    this.challenge = challenge;

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
    this.data = Buffer.alloc(25);

    this.index = this.data.writeInt32LE(-1, 0);
    this.index = this.data.writeUInt8(0x54, this.index);
    this.index += this.data.write('Source Engine Query', this.index);
    this.index = this.data.writeUInt8(0x00, this.index);

    return this.data;
  }

  player() {
    this.data = Buffer.alloc(9);

    this.index = this.data.writeInt32LE(-1, 0);
    this.index = this.data.writeUInt8(0x55, this.index);
    this.index = this.data.writeInt32LE(this.challenge, this.index);

    return this.data;
  }

  rules() {
    this.data = Buffer.alloc(9);

    this.index = this.data.writeInt32LE(-1, 0);
    this.index = this.data.writeUInt8(0x56, this.index);
    this.index = this.data.writeInt32LE(this.challenge, this.index);

    return this.data;
  }

  ping() {
    this.data = Buffer.alloc(5);

    this.index = this.data.writeInt32LE(-1, 0);
    this.index = this.data.writeUInt8(0x69, this.index);

    return this.data;
  }

  getchallenge() {
    this.data = Buffer.alloc(5);

    this.index = this.data.writeInt32LE(-1, 0);
    this.index = this.data.writeUInt8(0x57, this.index);

    return this.data;
  }
}

module.exports = RequestPacket;
