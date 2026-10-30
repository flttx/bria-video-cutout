import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';

// Never echo config, credentials or raw parsing errors to build output.
try {
  const [directory, source] = process.argv.slice(2);
  if (!directory) throw new Error();
  // Explicit files are isolated; the default matches the local API's env precedence.
  const config = source ? dotenv.parse(readFileSync(source)) : { ...process.env };
  if (!source) {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    dotenv.config({ path: ['apps/api/.env.kling.local', 'apps/api/.env', '.env', '.env.development'].map(name => resolve(root, name)), processEnv: config, quiet: true });
  }
  const token = config.BRIA_API_TOKEN?.trim();
  if (!token || /[\r\n\x00"\\]/.test(token)) throw new Error();
  const tripo=config.TRIPO_API_KEY?.trim();
  const region=config.TRIPO_API_REGION?.trim()||'china';
  if(tripo&&(/[\r\n\x00"\\]/.test(tripo)||!['china','global'].includes(region)))throw new Error();
  const kling=config.KLING_API_KEY?.trim(),klingRegion=config.KLING_API_REGION?.trim()||'china';
  if(kling&&(/[\r\n\x00"\\]/.test(kling)||!['china','global'].includes(klingRegion)))throw new Error();
  mkdirSync(directory, { recursive: true });
  const proxy = randomBytes(32).toString('hex');
  const write = (name, value) => writeFileSync(resolve(directory, name), value, { mode: 0o600, flag: 'wx' });
  write('api.env', `BRIA_API_TOKEN="${token}"\nCUTOUT_API_PASSWORD=${proxy}\nCUTOUT_ACCESS_MODE=basic\nBRIA_TRANSPORT=direct\n${tripo?`TRIPO_API_KEY="${tripo}"\nTRIPO_API_REGION=${region}\n`:''}${kling?`KLING_API_KEY="${kling}"\nKLING_API_REGION=${klingRegion}\n`:''}`);
  write('PRIVATE_ACCESS.txt', `Username: admin\nPassword: ${proxy}\nAPI credential for automatic HTTP authentication. No login screen required.\nThis is NOT the Bria API token.\n`);
  console.log('Private build configuration prepared; credential values omitted.');
} catch {
  console.error('PRIVATE_CONFIG_FAILED: check source token and output directory.');
  process.exit(1);
}
