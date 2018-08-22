/**
 * @class RequestPacket
 * @param {string} type Type of request packet to create
 * @param {number} [challenge=-1] A challenge number must be passed for player and rules packets. This is obtained by first creating a request packet of the respective type without a challenge.
 */
class RequestPacket {
  /**
   * Create a RequestPacket
   */
  constructor(type, challenge = -1) {
    /**
     * @type {?Buffer}
     * @default null
     */
    this.data = null;

    /**
     * @type {number}
     * @default 0
     */
    this.index = 0;

    /**
     * @type {number}
     * @default challenge
     */
    this.challenge = challenge;

    switch (type) {
      case 'info':
        return this._info();
      case 'player':
        return this._player();
      case 'rules':
        return this._rules();
      case 'challenge':
        return this._getChallenge();
      case 'ping':
        return this._ping();
    }
  }

  /**
   * Create an info request packet
   *
   * @memberof RequestPacket
   * @method info
   * @returns {Buffer} Packet data
   */
  _info() {
    this.data = Buffer.alloc(25);

    this.index = this.data.writeInt32LE(-1, 0);
    this.index = this.data.writeUInt8(0x54, this.index);
    this.index += this.data.write('Source Engine Query', this.index);
    this.index = this.data.writeUInt8(0x00, this.index);

    return this.data;
  }

  /**
   * Create a player request packet
   *
   * @memberof RequestPacket
   * @method player
   * @returns {Buffer} Packet data
   */
  _player() {
    this.data = Buffer.alloc(9);

    this.index = this.data.writeInt32LE(-1, 0);
    this.index = this.data.writeUInt8(0x55, this.index);
    this.index = this.data.writeInt32LE(this.challenge, this.index);

    return this.data;
  }

  /**
   * Create a rules request packet
   *
   * @memberof RequestPacket
   * @method rules
   * @returns {Buffer} Packet data
   */
  _rules() {
    this.data = Buffer.alloc(9);

    this.index = this.data.writeInt32LE(-1, 0);
    this.index = this.data.writeUInt8(0x56, this.index);
    this.index = this.data.writeInt32LE(this.challenge, this.index);

    return this.data;
  }

  /**
   * Create a ping request packet
   *
   * @memberof RequestPacket
   * @method ping
   * @returns {Buffer} Packet data
   */
  _ping() {
    this.data = Buffer.alloc(5);

    this.index = this.data.writeInt32LE(-1, 0);
    this.index = this.data.writeUInt8(0x69, this.index);

    return this.data;
  }

  /**
   * Create a challenge request packet
   *
   * @memberof RequestPacket
   * @method getChallenge
   * @returns {Buffer} Packet data
   */
  _getChallenge() {
    this.data = Buffer.alloc(5);

    this.index = this.data.writeInt32LE(-1, 0);
    this.index = this.data.writeUInt8(0x57, this.index);

    return this.data;
  }
}

module.exports = RequestPacket;
