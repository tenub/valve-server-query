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

  await describe('#connect()', async () => {
    it('should not have a socket reference before connecting', () => {
      assert.strictEqual(serverQuery.socket, null);
    });

    it('should have a socket reference once connected', async () => {
      await serverQuery.connect();

      assert.ok(serverQuery.socket);
    });
  });

  await describe('#query()', async () => {
    await it('should return an empty array when the input array is empty', async () => {
      serverQuery.connections = [];

      await serverQuery.query();

      serverQuery.on('done', (data) => {
        assert.strictEqual(data, []);
      });
    });

    await it('should return an empty array when the input array is missing', async () => {
      delete serverQuery.connections;

      await serverQuery.query();

      serverQuery.on('done', (data) => {
        assert.strictEqual(data, []);
      });
    });

    await it('should emit an error when an invalid input connection exists', async () => {
      serverQuery.connections = ['string'];

      await serverQuery.query();

      serverQuery.on('error', (err) => {
        assert.strictEqual(err instanceof Error, true);
      });
    });
  });
});
