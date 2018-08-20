const ServerQuery = require('../src');
const servers = require('./servers');

const serverQuery = new ServerQuery(servers);

serverQuery.on('error', (err) => {
  console.error(err);
  process.exit(1);
});

serverQuery.on('done', (data) => {
  // done
  //console.info(data);
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

serverQuery.on('ping', (data) => {
  // ping response
});

serverQuery.on('challenge', () => {
  // challenge response
});
