import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import dotenv from 'dotenv';
import { chromium } from 'playwright';

// Read-only application requests: no real Bria job is submitted.
const directory=resolve(process.argv[2]);
const docker=process.env.DOCKER_EXECUTABLE||'docker';
const login=readFileSync(resolve(directory,'PRIVATE_ACCESS.txt'),'utf8');
const username=login.match(/^Username: (.+)$/m)?.[1],password=login.match(/^Password: (.+)$/m)?.[1];
assert.ok(username&&password,'Private API login is required');
const token=dotenv.parse(readFileSync('.env.development')).BRIA_API_TOKEN;
assert.ok(token,'Local source token is required for leakage checks');
const auth='Basic '+Buffer.from(`${username}:${password}`).toString('base64');
const base='http://localhost:3001';
for(const path of ['/','/api/health','/api/jobs'])assert.equal((await fetch(base+path)).status,401);
assert.equal((await fetch(base+'/api/health',{headers:{Authorization:'Basic wrong'}})).status,401);
for(const path of ['/api/health','/api/config','/api/jobs']){
  const response=await fetch(base+path,{headers:{Authorization:auth}});
  assert.equal(response.status,200);
  assert.ok(!(await response.text()).includes(token),'API response must not contain Bria token');
}
assert.equal((await fetch(base,{headers:{Authorization:auth}})).status,404,'API image has no webpage');
assert.equal((await fetch(base+'/api/health',{headers:{Authorization:auth,Origin:'https://wrong.example'}})).status,403);
const run=args=>execFileSync(docker,['compose','-f',resolve(directory,'compose.yaml'),...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true});
const check="import './apps/api/dist/env.js'; import fs from 'node:fs'; if(!process.env.BRIA_API_TOKEN||process.env.CUTOUT_API_PASSWORD.length<32||process.getuid()===0||fs.existsSync('/app/apps/web')||fs.existsSync('/usr/share/nginx/html'))process.exit(2);";
run(['exec','-T','api','node','--input-type=module','-e',check]);
assert.ok(!run(['logs','--no-color','api']).includes(token),'Logs must not contain Bria token');
const front=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>API CORS smoke</title>');});
await new Promise(resolve=>front.listen(8080,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_TEST_EXECUTABLE||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined)});
  const page=await browser.newPage();
  await page.goto('http://localhost:8080');
  const status=await page.evaluate(async ({base,auth})=>(await fetch(base+'/api/health',{headers:{Authorization:auth}})).status,{base,auth});
  assert.equal(status,200,'Real browser separate-origin fetch including preflight');
  await page.goto('http://127.0.0.1:8080');
  const blocked=await page.evaluate(async ({base,auth})=>{try{await fetch(base+'/api/health',{headers:{Authorization:auth}});return false;}catch{return true;}},{base,auth});
  assert.equal(blocked,true,'Browser must block unconfigured Origin');
} finally {await browser?.close();await new Promise(resolve=>front.close(resolve));}
console.log('PASS: pure backend image, no web files, embedded private config, non-root API, anonymous/wrong login denied, native-app-style calls, real browser CORS allowed/denied, no token leakage. No Bria submission.');
