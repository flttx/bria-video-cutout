import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, copyFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { deploymentSettings } from '../apps/api/src/deployment.js';
import { createServer } from '../apps/api/src/app.js';
import { Store } from '../apps/api/src/store.js';
import { Pipeline } from '../apps/api/src/pipeline.js';
import { command } from '../apps/api/src/media.js';
import type { JobRecord, ExportRecord } from '../apps/api/src/model.js';

const proxyToken='synthetic-proxy-token-for-tests-only';
test('standalone loads only explicit private config and runtime values win',async t=>{
  const file=resolve('.tmp',`env-${randomUUID()}.env`);
  await writeFile(file,'BRIA_API_TOKEN=synthetic-file-token\nWEB_ORIGIN=https://file.example\n');
  t.after(()=>unlink(file));
  const env={...process.env,CUTOUT_DEPLOYMENT:'standalone',CUTOUT_CONFIG_FILE:file,WEB_ORIGIN:'https://runtime.example'};
  delete env.BRIA_API_TOKEN;
  const script="await import('./apps/api/src/env.ts'); if(process.env.BRIA_API_TOKEN!=='synthetic-file-token'||process.env.WEB_ORIGIN!=='https://runtime.example')process.exit(2)";
  assert.equal(spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{env}).status,0);
  assert.notEqual(spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{env:{...env,CUTOUT_CONFIG_FILE:file+'.missing'}}).status,0);
  assert.equal(spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"await import('./apps/api/src/env.ts'); if(process.env.BRIA_API_TOKEN)process.exit(2)"],{env:{...env,CUTOUT_CONFIG_FILE:''}}).status,0);
});
test('standalone configuration fails closed; local mode stays loopback',()=>{
  const env={CUTOUT_DEPLOYMENT:'standalone',BRIA_TRANSPORT:'direct',BRIA_API_TOKEN:'synthetic',WEB_ORIGIN:'https://cutout.example.com',CUTOUT_PROXY_TOKEN:proxyToken,DATA_DIR:'/app/data'};
  assert.equal(deploymentSettings(env).host,'0.0.0.0');
  for(const origin of ['http://localhost:8080','http://127.0.0.1:8080','http://[::1]:8080'])assert.equal(deploymentSettings({...env,WEB_ORIGIN:origin}).access?.origin,origin);
  assert.equal(deploymentSettings({}).host,'127.0.0.1');
  assert.equal(deploymentSettings({...env,CUTOUT_ACCESS_MODE:'basic',CUTOUT_API_PASSWORD:proxyToken}).access?.mode,'basic');
  assert.throws(()=>deploymentSettings({...env,CUTOUT_ACCESS_MODE:'basic',CUTOUT_API_PASSWORD:''}));
  assert.throws(()=>deploymentSettings({...env,CUTOUT_ACCESS_MODE:'invalid'}));
  for(const invalid of [{CUTOUT_DEPLOYMENT:'typo'},{BRIA_TRANSPORT:'cloud'},{BRIA_API_TOKEN:''},{WEB_ORIGIN:'http://cutout.example.com'},{WEB_ORIGIN:'http://localhost.evil.example:8080'},{WEB_ORIGIN:'http://192.0.2.1:8080'},{WEB_ORIGIN:'https://cutout.example.com/'},{CUTOUT_PROXY_TOKEN:'short'},{DATA_DIR:''},{API_PORT:'0'}])assert.throws(()=>deploymentSettings({...env,...invalid}));
});

test('direct API supports authenticated separate web and native apps with exact CORS',async t=>{
  const origin='https://frontend.example';
  const app=await createServer(new Pipeline(new Store(resolve('.tmp',randomUUID())),undefined),false,undefined,undefined,{origin,proxyToken,mode:'basic'});
  t.after(()=>app.close());
  const authorization='Basic '+Buffer.from(`admin:${proxyToken}`).toString('base64');
  for(const headers of [{},{authorization:'Basic wrong'},{'x-cutout-proxy-token':proxyToken}])assert.equal((await app.inject({url:'/api/health',headers})).statusCode,401);
  const preflight=await app.inject({method:'OPTIONS',url:'/api/videos',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'authorization,content-type,x-cutout-client,x-video-filename'}});
  assert.equal(preflight.statusCode,204);assert.equal(preflight.headers['access-control-allow-origin'],origin);
  const web=await app.inject({url:'/api/health',headers:{origin,authorization,'sec-fetch-site':'cross-site'}});
  assert.equal(web.statusCode,200);assert.equal(web.headers['access-control-allow-origin'],origin);
  assert.match(String(web.headers['access-control-expose-headers']),/Content-Range/i);
  assert.equal((await app.inject({url:'/api/health',headers:{authorization}})).statusCode,200,'Native app has no Origin');
  assert.equal((await app.inject({url:'/api/health',headers:{origin:'https://evil.example',authorization}})).statusCode,403);
  const invalidPreflight=await app.inject({method:'OPTIONS',url:'/api/videos',headers:{origin:'https://evil.example','access-control-request-method':'POST'}});
  assert.equal(invalidPreflight.headers['access-control-allow-origin'],undefined);
  // These reach the unconfigured pipeline, without submitting any upstream request.
  for(const headers of [{authorization,'x-cutout-client':'1'},{authorization,origin,'x-cutout-client':'1','sec-fetch-site':'cross-site'}])assert.equal((await app.inject({method:'POST',url:'/api/jobs',headers,payload:{}})).statusCode,503);
  assert.equal((await app.inject({method:'POST',url:'/api/jobs',headers:{authorization,origin},payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/jobs',headers:{authorization,'x-cutout-client':'1','sec-fetch-site':'cross-site'},payload:{}})).statusCode,403);
});

test('all API resources require proxy authentication and same-origin mutations',async t=>{
  const app=await createServer(new Pipeline(new Store(resolve('.tmp',randomUUID())),undefined),false,undefined,undefined,{origin:'https://cutout.example.com',proxyToken});
  t.after(()=>app.close());
  for(const url of ['/api/health','/api/config','/api/jobs',`/api/videos/${randomUUID()}/file`,`/api/exports/${randomUUID()}/file`]) {
    assert.equal((await app.inject({url})).statusCode,401);
    assert.equal((await app.inject({url,headers:{'x-cutout-proxy-token':'forged'}})).statusCode,401);
  }
  const headers={'x-cutout-proxy-token':proxyToken,'x-cutout-client':'1'};
  assert.equal((await app.inject({url:'/api/health',headers})).statusCode,200);
  for(const origin of [undefined,'https://evil.example','http://localhost:5174'])assert.equal((await app.inject({method:'POST',url:'/api/jobs',headers:{...headers,...(origin?{origin}:{})},payload:{}})).statusCode,403);
  assert.equal((await app.inject({url:'/api/jobs',headers:{...headers,'sec-fetch-site':'cross-site'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/jobs',headers:{...headers,origin:'https://cutout.example.com'},payload:{}})).statusCode,503);
  assert.equal((await app.inject({method:'POST',url:'/api/jobs',headers:{'x-cutout-proxy-token':proxyToken,origin:'https://cutout.example.com'},payload:{}})).statusCode,403);
});

test('server upload, preview, media ranges, persistent recovery and cached recolor',async t=>{
  const root=resolve('.tmp/standalone-tests',randomUUID());await mkdir(root,{recursive:true});
  const source=resolve(root,'source.mp4'),mask=resolve(root,'mask.mp4');
  await command('ffmpeg',['-y','-f','lavfi','-i','color=c=red:s=320x180:r=24:d=1','-f','lavfi','-i','sine=duration=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
  await command('ffmpeg',['-y','-f','lavfi','-i','color=c=white:s=320x180:r=24:d=1','-c:v','libx264','-pix_fmt','yuv420p',mask]);
  let submissions=0,hold=true;
  const submit=async()=>{submissions++;return {request_id:'synthetic-request'};};
  const gateway={upload:async()=> 'https://example.invalid/video',autoForeground:submit,maskByPrompt:submit,maskByPoints:submit,status:async()=>({status:hold?'IN_PROGRESS' as const:'COMPLETED' as const,result:{mask_url:'https://example.invalid/mask'}}),download:async(_url:string,path:string)=>{await copyFile(mask,path);}};
  const store=new Store(resolve(root,'data'));let engine=new Pipeline(store,gateway,5,1000);
  const origin='http://127.0.0.1:5186';
  let app=await createServer(engine,true,undefined,undefined,{origin,proxyToken});
  const headers={'x-cutout-proxy-token':proxyToken,origin,'x-cutout-client':'1'};
  const bytes=await readFile(source);
  const uploaded=await app.inject({method:'POST',url:'/api/videos',headers:{...headers,'content-type':'application/octet-stream','x-video-filename':encodeURIComponent('服务器测试.mp4')},payload:bytes});
  assert.equal(uploaded.statusCode,201,uploaded.body);const video=uploaded.json();
  assert.equal(video.filename,'服务器测试.mp4');
  assert.deepEqual(await readFile(store.path('videos',video.id,'source')),bytes);
  assert.equal((await app.inject({method:'POST',url:`/api/videos/${video.id}/preview`,headers,payload:{}})).statusCode,200);
  assert.equal((await app.inject({url:`/api/videos/${video.id}/preview`,headers:{...headers,range:'bytes=0-31'}})).statusCode,206);
  const input={id:randomUUID(),videoId:video.id,mode:'prompt',prompt:'red',points:[],start:0,end:1,reusable:true,color:'White',resolution:'source'};
  assert.equal((await app.inject({method:'POST',url:'/api/jobs',headers,payload:input})).statusCode,202);
  await engine.idle();
  assert.equal((await store.get<JobRecord>('jobs',input.id)).state,'failed');
  await app.close();hold=false;
  engine=new Pipeline(new Store(store.root),gateway,1,2000);
  app=await createServer(engine,true,undefined,undefined,{origin,proxyToken});t.after(()=>app.close());
  await engine.initialize();await engine.resume(input.id);await engine.idle();
  assert.equal(submissions,1,'Restart and resume must query the accepted job');
  const job=await store.get<JobRecord>('jobs',input.id);assert.equal(job.state,'completed',JSON.stringify(job.error));
  const exportId=randomUUID();await engine.createExport(job.id,{id:exportId,color:'Blue',resolution:'source'});await engine.idle();
  const output=await store.get<ExportRecord>('exports',exportId);assert.equal(output.state,'completed');assert.equal(output.meta?.hasAudio,true);assert.equal(submissions,1);
  const fileUrl=`/api/exports/${exportId}/file`;
  const whole=await app.inject({url:fileUrl,headers});
  const range=await app.inject({url:fileUrl,headers:{...headers,range:'bytes=1-31'}});
  assert.equal(range.statusCode,206);assert.deepEqual(range.rawPayload,whole.rawPayload.subarray(1,32));
  assert.match((await app.inject({url:fileUrl+'?download=1',headers})).headers['content-disposition'] as string,/^attachment/);
  assert.equal((await app.inject({url:fileUrl,headers:{...headers,range:'bytes=999999999-'}})).statusCode,416);
  assert.equal((await app.inject({url:`/api/jobs/${job.id}/thumbnail`,headers})).statusCode,200);
  assert.ok(!JSON.stringify((await app.inject({url:'/api/jobs',headers})).json()).includes('example.invalid'));
});
