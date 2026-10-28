import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';

// Never echo config, credentials or raw parsing errors to build output.
try {
  const [directory, source] = process.argv.slice(2);
  if (!directory || !source) throw new Error();
  const token = dotenv.parse(readFileSync(source)).BRIA_API_TOKEN?.trim();
  if (!token || /[\r\n\x00"\\]/.test(token)) throw new Error();
  mkdirSync(directory, { recursive: true });
  const proxy = randomBytes(32).toString('hex');
  const write = (name, value) => writeFileSync(resolve(directory, name), value, { mode: 0o600, flag: 'wx' });
  write('api.env', `BRIA_API_TOKEN="${token}"\nCUTOUT_API_PASSWORD=${proxy}\nCUTOUT_ACCESS_MODE=basic\nBRIA_TRANSPORT=direct\n`);
  write('PRIVATE_ACCESS.txt', `Username: admin\nPassword: ${proxy}\nAPI credential for automatic HTTP authentication. No login screen required.\nThis is NOT the Bria API token.\n`);
  console.log('Private build configuration prepared; credential values omitted.');
} catch {
  console.error('PRIVATE_CONFIG_FAILED: check source token and output directory.');
  process.exit(1);
}
