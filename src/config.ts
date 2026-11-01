import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIR = 'radar-cnpj-mcp';

/** Where the imported database lives. Override with RADAR_CNPJ_DB. */
export function defaultDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.RADAR_CNPJ_DB) {
    return env.RADAR_CNPJ_DB;
  }
  return join(dataDir(env, platform, home), APP_DIR, 'radar.duckdb');
}

/** Where CSV exports requested through MCP are written. Override with RADAR_CNPJ_EXPORT_DIR. */
export function defaultExportDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return env.RADAR_CNPJ_EXPORT_DIR ?? join(home, APP_DIR);
}

function dataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (platform === 'win32') {
    return env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support');
  }
  return env.XDG_DATA_HOME ?? join(home, '.local', 'share');
}
