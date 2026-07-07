'use strict';

try {
  require('./dist/server');
} catch (error) {
  if (error && error.code === 'MODULE_NOT_FOUND') {
    console.error('The TypeScript server has not been built yet.');
    console.error('Run: npm start');
    process.exit(1);
  }
  throw error;
}
