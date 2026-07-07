import { loadConfig } from './config';
import { createServer } from './http-server';

const config = loadConfig();
const { httpServer, staticFiles } = createServer(config);

httpServer.listen(config.port, config.host, () => {
  console.log('====================================================================');
  console.log(' Restaurant City - local server');
  console.log('====================================================================');
  console.log(` Listening      : http://localhost:${config.port}`);
  console.log(` Dashboard      : http://localhost:${config.port}/__dash`);
  console.log(` Static files   : ${staticFiles.size} indexed (RC root + bin-xml)`);
  console.log(` game.swf serves: ${staticFiles.servesRebuiltGameSwf() ? 'REBUILT (localhost-wired)' : 'original'}`);
  console.log('');
  console.log(' Launch the client so it loads FROM this server:');
  console.log(`   "C:\\flex\\Player\\flashplayer_32_sa_debug.exe" http://localhost:${config.port}/game.swf`);
  console.log('====================================================================');
});
