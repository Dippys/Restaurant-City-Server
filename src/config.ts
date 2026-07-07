import * as path from 'node:path';

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly serverRoot: string;
  readonly rcRoot: string;
  readonly binXmlRoot: string;
  readonly originalAssetRoot: string;
  readonly useOriginalAssetSwfs: boolean;
  readonly rebuiltSwf: string;
  readonly maxLogEntries: number;
}

export function loadConfig(): ServerConfig {
  const serverRoot = path.resolve(__dirname, '..');
  const rcRoot = path.resolve(serverRoot, '..');

  return {
    port: Number(process.env.PORT) || 8090,
    host: process.env.HOST || '0.0.0.0',
    serverRoot,
    rcRoot,
    binXmlRoot: path.join(rcRoot, 'bin-xml'),
    originalAssetRoot: path.join(rcRoot, 'backup'),
    useOriginalAssetSwfs: process.env.USE_REBUILT_ASSET_SWFS !== '1',
    rebuiltSwf: path.join(rcRoot, 'decompiled', 'game', 'bin', 'game.swf'),
    maxLogEntries: Number(process.env.MAX_LOG_ENTRIES) || 500,
  };
}
