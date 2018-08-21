const { Uint64LE } = require('int64-buffer');

class ResponsePacket {
  constructor(data) {
    this.data = data;
    this.index = 0;
  }

  /**
   * Read a long long, long, short, or integer from a response packet
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
   */
  readFloat() {
    const value = this.data.readFloatLE(this.index);

    this.index += 4;

    return value;
  }

  /**
   * Read a character (integer) from a response packet
   */
  readChar() {
    const chrCode = this.readInt(1);
    const chr = String.fromCharCode(chrCode);

    return chr;
  }

  /**
   * Read a string from a response packet
   * A string will always be terminated with a "0"
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
