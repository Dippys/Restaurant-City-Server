import { loadConfig } from './config';
import { createServer } from './http-server';

const config = loadConfig();
const { httpServer, staticFiles } = createServer(config);

httpServer.listen(config.port, config.host, () => {
  console.log('====================================================================');
  console.log(' Restaurant City Reborn - local server');
  console.log('====================================================================');
  console.log(` Listening      : http://localhost:${config.port}`);
  console.log(` Dashboard      : http://localhost:${config.port}/__dash`);
  console.log(` Static files   : ${staticFiles.size} indexed (self-contained: server/public)`);
  console.log(` game.swf serves: ${staticFiles.servesRebuiltGameSwf() ? 'REBUILT (localhost-wired)' : 'original'}`);
  console.log('');
  console.log(' Launch the client so it loads FROM this server:');
  console.log(`   "C:\\flex\\Player\\flashplayer_32_sa_debug.exe" http://localhost:${config.port}/game.swf`);
  console.log('====================================================================');
});
