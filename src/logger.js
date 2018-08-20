const { createLogger, format, transports } = require('winston');

const { colorize, combine, timestamp, printf, splat } = format;

const logger = createLogger({
  format: combine(
    colorize(),
    splat(),
    timestamp(),
    printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  level: 'debug',
  transports: [
    new transports.Console()
  ]
});

module.exports = logger;
