const { Uint64LE } = require('int64-buffer');

/**
 * @class ResponsePacket
 * @param {Buffer} data Data received from the remote host
 */
class ResponsePacket {
  /**
   * Create a ResponsePacket
   */
  constructor(data) {
    /**
     * @type {Buffer}
     * @default data
     */
    this.data = data;

    /**
     * @type {number}
     * @default 0
     */
    this.index = 0;
  }

  /**
   * Read a long long, long, short, or integer from a response packet
   *
   * @memberof ResponsePacket
   * @method readInt
   * @param {number} [bytes=1] Number of bytes to read
   * @returns {number} Integer value
   */
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

  /**
   * Read a float from a response packet
   *
   * @memberof ResponsePacket
   * @method readFloat
   * @returns {number} Float value
   */
  readFloat() {
    const value = this.data.readFloatLE(this.index);

    this.index += 4;

    return value;
  }

  /**
   * Read a character (integer) from a response packet
   *
   * @memberof ResponsePacket
   * @method readChar
   * @returns {string} Character value
   */
  readChar() {
    const chrCode = this.readInt(1);
    const chr = String.fromCharCode(chrCode);

    return chr;
  }

  /**
   * Read a string from a response packet
   * A string will always be terminated with a "0"
   *
   * @memberof ResponsePacket
   * @method readString
   * @returns {string} String value
   */
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

module.exports = ResponsePacket;
