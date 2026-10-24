// Raw credentials are written only to an ignored local file, never CLI arguments or stdout.
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
if(args.some(arg=>!['--remote','--local','--revoke-all','--permanent'].includes(arg))||args.includes('--remote')===args.includes('--local')||(args.includes('--permanent')&&args.includes('--revoke-all'))) {
  throw new Error('Specify exactly one of --remote or --local; use --permanent for reusable links, or --revoke-all to revoke all personal links and sessions.');
}
const remote=args.includes('--remote'),revoke=args.includes('--revoke-all'),permanent=args.includes('--permanent');
const dir=join(root,'.tmp');await mkdir(dir,{recursive:true});
const sqlFile=join(dir,'access-grant-'+randomBytes(8).toString('hex')+'.sql');
const token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');
const expires=Date.now()+86400000;
const sql=revoke?"DELETE FROM browser_access_grants WHERE owner='personal-token-owner-v1';":
  `INSERT INTO browser_access_grants(token_hash,owner,expires_at,permanent) VALUES('${hash}','personal-token-owner-v1',${permanent?0:expires},${permanent?1:0});`;
await writeFile(sqlFile,sql,{mode:0o600});
try {
  const run=spawnSync(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB',remote?'--remote':'--local','--file',sqlFile],{cwd:join(root,'apps/worker'),encoding:'utf8',windowsHide:true});
  if(run.status!==0)throw new Error('D1 access grant operation failed. Check Wrangler login and migration 0004; no access link was issued.');
  if(revoke){await rm(join(dir,remote?'cloud-access-link.txt':'local-access-link.txt'),{force:true});console.log('All personal access links and sessions revoked.');}
  else {
    const origin=remote?'https://bria-video-cutout.flttxq.workers.dev':'https://localhost:8787';
    const output=join(dir,remote?'cloud-access-link.txt':'local-access-link.txt');
    const note=permanent?'Permanent reusable link: no automatic expiry. Reopen this same link whenever a 30-day browser session expires.':`One-time link. Redeem before ${new Date(expires).toISOString()}; session lasts 30 days.`;
    await writeFile(output,`${origin}/auth/token#token=${token}\n\n${note}\nKeep this file private; do not commit or share it.\n`,{mode:0o600});
    console.log('Access link saved to '+(remote?'.tmp/cloud-access-link.txt':'.tmp/local-access-link.txt')+' (contents hidden).');
  }
}finally{await rm(sqlFile,{force:true});}
