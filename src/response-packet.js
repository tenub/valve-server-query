const { Uint64LE } = require('int64-buffer');

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

module.exports = ResponsePacket;
