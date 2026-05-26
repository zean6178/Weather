'use strict';

const winston = require('winston');
const config = require('./config');

const logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      if (stack) {
        return `[${timestamp}] ${level.toUpperCase()}: ${message}\n${stack}`;
      }
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'bot-error.log',
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: 'bot-combined.log',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
  ],
});

module.exports = logger;
