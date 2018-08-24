const assert = require('assert');

const ServerQuery = require('../src');
const servers = require('./servers');

describe('ServerQuery', async () => {
  const serverQuery = new ServerQuery(servers);

  // all events that can have handlers attached
  serverQuery.on('error', (err) => {});
  serverQuery.on('info', (data) => {});
  serverQuery.on('player', (data) => {});
  serverQuery.on('rules', (data) => {});
  serverQuery.on('ping', (data) => {});
  serverQuery.on('challenge', (data) => {});
  serverQuery.on('done', (connections) => {});

  it('should have a reference of the connections array', () => {
    assert.deepStrictEqual(serverQuery.connections, servers);
  });


  describe('#connect()', () => {
    it('should not have a socket reference before connecting', () => {
      assert.strictEqual(serverQuery.socket, null);
    });

    it('should have a socket reference once connected', async () => {
      await serverQuery.connect();

      assert.ok(serverQuery.socket);
    });
  });

  describe('#query()', () => {
    it('should return an empty array when the input array is empty', async () => {
      serverQuery.connections = [];

      await serverQuery.query();

    });

    it('should emit an error when an invalid input connection exists', async () => {
      serverQuery.connections = ['string'];

      await serverQuery.query();

    });

    it('should emit an error when a connection is not running a game server' , async () => {
      serverQuery.connections = [{ host: '0.0.0.0', port: 27015 }];

      await serverQuery.query();

    });
  });

  describe('#_handleSocketError()', () => {
    it('should emit an error when passed', async () => {
      serverQuery._handleSocketError(new Error('Test error'));

    });
  });

  describe('#_handleSocketMessage()', () => {
    it('should emit an error when the message does not exist', async () => {
      serverQuery._handleSocketMessage();

    });

    it('should emit an error when the message has no size', async () => {
      serverQuery._handleSocketMessage(Buffer.from([]));

    });

    it('should emit an error when the message is received from a connection that does not exist in the reference array', (done) => {
      serverQuery.connections = servers;
      const [testServer] = serverQuery.connections;

      serverQuery._handleSocketMessage(Buffer.from([0x00]), testServer);

    });
  });
});
