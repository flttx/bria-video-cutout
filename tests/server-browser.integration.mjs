import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { createServer } from '../apps/api/src/app.ts';
import { Pipeline } from '../apps/api/src/pipeline.ts';
import { Store } from '../apps/api/src/store.ts';
import { command } from '../apps/api/src/media.ts';

const root=resolve('.tmp/server-browser',randomUUID());await mkdir(root,{recursive:true});
const source=resolve(root,'sample.mp4'),alpha=resolve(root,'alpha.webm');
await command('ffmpeg',['-y','-f','lavfi','-i','color=c=red:s=320x180:r=24:d=1','-c:v','libx264','-pix_fmt','yuv420p',source]);
await command('ffmpeg',['-y','-f','lavfi','-i','color=c=blue:s=320x180:r=24:d=1','-vf','drawbox=x=100:y=30:w=100:h=120:color=red:t=fill,format=rgba,colorkey=blue:0.1:0.0','-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0',alpha]);
let submissions=0,hold=true;
const submit=async()=>{submissions++;return {request_id:'synthetic'};};
const gateway={upload:async()=> 'https://example.invalid/source',autoForeground:submit,maskByPrompt:submit,maskByPoints:submit,status:async()=>({status:hold?'IN_PROGRESS':'COMPLETED',result:{video_url:'https://example.invalid/artifact'}}),download:async(_url,path)=>{await copyFile(alpha,path);}};
const engine=new Pipeline(new Store(resolve(root,'data')),gateway,20,60000);
const token='synthetic-browser-proxy-token-for-tests';
const app=await createServer(engine,true,undefined,undefined,{origin:'http://127.0.0.1:5186',proxyToken:token,mode:process.env.NGINX_TEST_EXECUTABLE?'proxy':'basic'});
const address=await app.listen({host:'127.0.0.1',port:0});
let server,browser,nginx;
const nginxPrefix=root.replaceAll('\\','/')+'/';
try {
  if(process.env.NGINX_TEST_EXECUTABLE) {
    // Reuse production HTTP routing/auth/streaming with local paths and upstream.
    const template=await readFile('deploy/standalone/nginx.conf.template','utf8');
    const site=template.replace('listen 80;','listen 127.0.0.1:5186;')
      .replaceAll('${CUTOUT_DOMAIN}','127.0.0.1').replaceAll('${CUTOUT_PROXY_TOKEN}',token)
      .replace('http://api:3001',address)
      .replace('/usr/share/nginx/html',`"${resolve('apps/web/dist-server').replaceAll('\\','/')}"`)
      .replace('/etc/nginx/private/htpasswd',`"${nginxPrefix}htpasswd"`);
    // SHA here is a synthetic test credential only; private images use random passwords with salted SSHA.
    await writeFile(resolve(root,'htpasswd'),'synthetic:{SHA}'+createHash('sha1').update('synthetic-password').digest('base64')+'\n');
    await mkdir(resolve(root,'logs'),{recursive:true});
    await mkdir(resolve(root,'temp'),{recursive:true});
    await writeFile(resolve(root,'nginx.conf'),`daemon off;
master_process off;
pid nginx.pid;
error_log logs/error.log;
events {}
http { types { text/html html; text/css css; application/javascript js; } ${site} }`);
    execFileSync(process.env.NGINX_TEST_EXECUTABLE,['-p',nginxPrefix,'-c','nginx.conf','-t'],{windowsHide:true,stdio:'pipe'});
    nginx=spawn(process.env.NGINX_TEST_EXECUTABLE,['-p',nginxPrefix,'-c','nginx.conf'],{windowsHide:true,stdio:'ignore'});
    let ready=false;
    for(let i=0;i<80;i++){try{const response=await fetch('http://127.0.0.1:5186/bria-cutout/api/health');assert.equal(response.status,401);ready=true;break;}catch{await delay(100);}}
    assert.ok(ready,'Nginx must start with the deployment routing configuration');
    assert.equal((await fetch('http://127.0.0.1:5186/')).status,401);
    assert.equal((await fetch('http://127.0.0.1:5186/bria-cutout/api/jobs',{headers:{'X-Cutout-Proxy-Token':token}})).status,401);
    assert.equal((await fetch('http://127.0.0.1:5186/bria-cutout/api/health',{headers:{Authorization:'Basic '+Buffer.from('synthetic:wrong').toString('base64')}})).status,401);
  } else {
    process.env.CUTOUT_API_BASE_URL=address;
    process.env.CUTOUT_API_PATH_PREFIX='';
    process.env.CUTOUT_API_USERNAME='admin';
    process.env.CUTOUT_API_PASSWORD=token;
    // Use the real startup-configured proxy, without a test-only header injection.
    server=await preview({configFile:resolve('apps/web/vite.config.ts'),root:resolve('apps/web'),mode:'server',preview:{host:'127.0.0.1',port:5186,strictPort:true}});
    assert.equal((await fetch(address+'/api/health')).status,401);
    assert.equal((await fetch('http://127.0.0.1:5186/bria-cutout/api/health')).status,200);
  }
  let executablePath=process.env.BROWSER_TEST_EXECUTABLE;
  if(!executablePath&&process.platform==='win32')for(const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']){try{await access(candidate);executablePath=candidate;break;}catch{}}
  browser=await chromium.launch({headless:true,executablePath});
  const context=await browser.newContext({viewport:{width:1440,height:1000},...(nginx?{httpCredentials:{username:'synthetic',password:'synthetic-password'}}:{})});
  await context.addInitScript(()=>{for(const mode of ['auto','prompt','points'])localStorage.setItem('bria-cutout.guide.'+mode+'.v1','1');});
  const forbidden=[],errors=[];
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname!=='127.0.0.1'||/^\/(api|browser|native|ffmpeg)\//.test(url.pathname)){forbidden.push(url.pathname);return route.abort();}return route.continue();});
  let page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5186');
  await page.getByText('服务器处理模式',{exact:true}).waitFor();
  await page.locator('input[type=file]').setInputFiles(source);
  await page.getByRole('button',{name:'开始抠图并导出',exact:true}).click();
  for(let i=0;i<200&&submissions===0;i++)await delay(100);
  assert.equal(submissions,1);await page.close();hold=false;await engine.idle();
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5186');
  await page.locator('.task-history summary').click();
  await page.getByRole('button',{name:'预览视频',exact:true}).first().click();
  await page.waitForFunction(()=>{const v=document.querySelector('dialog[open] video');return v?.readyState>=2&&v.videoWidth===320;});
  await page.getByRole('button',{name:'关闭预览',exact:true}).click();
  const event=page.waitForEvent('download');await page.getByRole('link',{name:'下载视频',exact:true}).first().click();
  const download=await event;assert.match(download.suggestedFilename(),/\.mp4$/);const downloaded=resolve(root,'download.mp4');await download.saveAs(downloaded);
  await command('ffmpeg',['-v','error','-i',downloaded,'-f','null','-']);
  await page.screenshot({path:resolve(root,'desktop.png'),fullPage:true});
  assert.equal(submissions,1);assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);
  console.log(`PASS: production server UI upload, page-close completion, persisted history, playback and download; no external assets/Worker/native bridge/WASM requests. ${nginx?'Real Nginx Basic Auth and reverse proxy; local HTTP only.':'Vite preview proxy.'} Bria mocked.`);
} finally {hold=false;await browser?.close();await new Promise(resolve=>server?server.httpServer.close(resolve):resolve());nginx?.kill();await engine.idle();await app.close();}
