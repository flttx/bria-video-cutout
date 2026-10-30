import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../apps/api/src/app.js';
import { Pipeline } from '../apps/api/src/pipeline.js';
import { Store } from '../apps/api/src/store.js';
import { command } from '../apps/api/src/media.js';
import { KlingClient, klingSettings } from '../apps/api/src/kling.js';
import type { KlingGateway } from '../apps/api/src/kling.js';
import type { ImageVideoRecord } from '../apps/api/src/image-videos.js';
import type { ImageRecord } from '../apps/api/src/images.js';

const origin='http://localhost:5199',token='synthetic-kling-test';
const headers={origin,authorization:'Basic '+Buffer.from('admin:'+token).toString('base64'),'x-cutout-client':'1'};
async function fixture(){
  const root=resolve('.tmp/kling-tests',randomUUID());await mkdir(root,{recursive:true});
  const source=resolve(root,'source.png'),alpha=resolve(root,'alpha.png'),video=resolve(root,'video.mp4');
  await command('ffmpeg',['-y','-f','lavfi','-i','color=blue:s=360x640,format=rgba,drawbox=x=100:y=200:w=160:h=240:color=red:t=fill','-frames:v','1',source]);
  await command('ffmpeg',['-y','-i',source,'-vf','colorkey=blue:0.1:0.0','-frames:v','1',alpha]);
  await command('ffmpeg',['-y','-f','lavfi','-i','color=white:s=1080x1920:r=24:d=6','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',video]);
  let whites=0,videos=0,queries=0,downloadFail=false,submitFail=false,empty=false,upstreamFailed=false;
  const bria={imageForeground:async()=>{whites++;return {request_id:'white-test'};},status:async()=>({status:'COMPLETED' as const,result:{image_url:'https://example.invalid/alpha'}}),download:async(_url:string,file:string)=>copyFile(alpha,file),
    upload:async()=>{throw new Error('No video upload');},autoForeground:async()=>{throw new Error('No video cutout');},maskByPrompt:async()=>{throw new Error('No video cutout');},maskByPoints:async()=>{throw new Error('No video cutout');}};
  const store=new Store(resolve(root,'data'));
  const kling:KlingGateway={region:'china',submit:async(file,external)=>{
    videos++;assert.match(external,/^white-/);const id=external.slice(6);
    assert.deepEqual(await readFile(file),await readFile(store.path('images',id,'white.png')));
    assert.notDeepEqual(await readFile(file),await readFile(source),'Kling receives Bria white output, not original');
    if(submitFail)throw new Error('private key or url');return 'kling-test';
  },query:async(value,external)=>{queries++;assert.equal(value,external?value:'kling-test');if(empty)return;return {id:'kling-test',status:upstreamFailed?'failed':'succeeded',url:'https://example.invalid/signed-video'};},download:async(_url,file)=>{if(downloadFail)throw new Error('private-download');await copyFile(video,file);}};
  return {root,source,video,store,bria,kling,get whites(){return whites;},get videos(){return videos;},get queries(){return queries;},set downloadFail(v:boolean){downloadFail=v;},set submitFail(v:boolean){submitFail=v;},set empty(v:boolean){empty=v;},set upstreamFailed(v:boolean){upstreamFailed=v;}};
}
async function setup(t:test.TestContext){
  const f=await fixture(),engine=new Pipeline(f.store,f.bria,5,30000,{},undefined,f.kling);
  const app=await createServer(engine,true,undefined,undefined,{origin,proxyToken:token,mode:'basic'});t.after(()=>app.close());
  const upload=await app.inject({method:'POST',url:'/api/images',headers:{...headers,'content-type':'application/octet-stream'},payload:await readFile(f.source)});
  assert.equal(upload.statusCode,201);return {f,engine,app,id:upload.json().id as string};
}

test('Kling official API protocol: server key, Base64 white input, fixed settings, matching task IDs and sanitized failures',async()=>{
  const root=resolve('.tmp/kling-protocol',randomUUID());await mkdir(root,{recursive:true});const file=resolve(root,'white.png');await writeFile(file,'synthetic-white-image');
  let calls=0;
  const client=new KlingClient('synthetic-key','china',async(url,init)=>{
    calls++;assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-key');assert.equal(init?.redirect,'error');
    if(init?.method==='POST'){
      assert.equal(String(url),'https://api-beijing.klingai.com/image-to-video/kling-3.0');const body=JSON.parse(String(init.body));
      assert.deepEqual(body.settings,{resolution:'1080p',duration:6,audio:'off',multi_shot:false});assert.equal(body.contents[1].url,Buffer.from('synthetic-white-image').toString('base64'));
      assert.match(body.contents[0].text,/15 degrees to the viewer's left by 2 seconds.*return to the original reference orientation by 4 seconds.*15 degrees to the viewer's right by 6 seconds/);assert.equal(body.options.external_task_id,'external-test');
      assert.doesNotMatch(body.contents[0].text,/turntable shot|主体结构|表面与遮挡|机器人|脸板|眼睛/i);
      assert.match(body.contents[0].text,/Do not add any pedestal, base, platform/);
      assert.match(body.contents[0].text,/relative positions, distances and angles of every part must remain unchanged/);
      assert.match(body.contents[0].text,/No articulation or independent motion of any part/);
      assert.doesNotMatch(body.contents[0].text,/360|quarter-turn|rear side at|no.*reverse rotation/i);
      return Response.json({code:0,data:{id:'task-test'}});
    }
    const external=String(url).includes('external_task_ids');
    return Response.json({code:0,data:[{id:'task-test',external_id:external?'external-test':undefined,status:'succeeded',outputs:[{type:'video',url:'https://example.com/video.mp4'}]}]});
  });
  assert.equal(await client.submit(file,'external-test'),'task-test');assert.equal((await client.query('task-test'))?.status,'succeeded');assert.equal((await client.query('external-test',true))?.id,'task-test');assert.equal(calls,3);
  for(const response of [()=>Response.json({code:1,message:'secret'}),()=>new Response('secret',{status:401}),()=>Response.json({code:0,data:[{id:'other',status:'processing'}]})]){
    let count=0;const bad=new KlingClient('key','global',async url=>{count++;assert.match(String(url),/^https:\/\/api-singapore.klingai.com/);return response();});
    await assert.rejects(bad.query('task-test'),error=>error instanceof Error&&!error.message.includes('secret'));assert.equal(count,1);
  }
  const empty=new KlingClient('key','china',async()=>Response.json({code:0,data:[]}));assert.equal(await empty.query('external',true),undefined);await assert.rejects(empty.query('task'));
  await assert.rejects(client.download('http://127.0.0.1/private','unused',1000));assert.equal(calls,3);
  assert.equal(klingSettings({}),undefined);assert.throws(()=>klingSettings({KLING_API_KEY:'key',KLING_API_REGION:'invalid'}));
});

test('Bria to Kling pipeline deduplicates, saves real video, enforces auth and caches without credentials',async t=>{
  const {f,engine,app,id}=await setup(t);
  const originalQuery=f.kling.query;let stage=0;
  f.kling.query=async(...args)=>{
    stage++;
    if(stage>1){const current=(await app.inject({url:`/api/image-videos/${id}`,headers})).json();
      assert.equal(current.state,'processing');assert.equal(current.providerStatus,stage===2?'submitted':'processing');
      assert.ok(Number.isFinite(Date.parse(current.lastCheckedAt)),'a successful platform query has a visible confirmation time');}
    if(stage<3)return {id:'kling-test',status:stage===1?'submitted':'processing'};
    return originalQuery(...args);
  };
  assert.equal((await app.inject({url:'/api/image-videos'})).statusCode,401);
  assert.equal((await app.inject({url:'/api/health',headers})).json().klingVideoEnabled,true);
  assert.equal((await app.inject({method:'POST',url:'/api/image-videos',headers:{...headers,origin:'https://evil.example'},payload:{imageId:id}})).statusCode,403);
  const starts=await Promise.all([1,2,3].map(()=>app.inject({method:'POST',url:'/api/image-videos',headers,payload:{imageId:id}})));assert.ok(starts.every(r=>r.statusCode===202));await engine.idle();
  const done=(await app.inject({url:`/api/image-videos/${id}`,headers})).json();assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(f.whites,1);assert.equal(f.videos,1);assert.deepEqual(done.meta,{width:1080,height:1920,duration:6});
  assert.equal(done.providerStatus,'succeeded');assert.equal(stage,3);
  assert.ok(!/externalId|requestId|signed-video|submissionAttempted|private/.test(JSON.stringify(done)));
  const file=await app.inject({url:done.videoUrl+'?download=1',headers});assert.deepEqual(file.rawPayload,await readFile(f.video));assert.match(String(file.headers['content-disposition']),/^attachment/);
  const range=await app.inject({url:done.videoUrl,headers:{...headers,range:'bytes=0-99'}});assert.equal(range.statusCode,206);assert.equal(range.rawPayload.length,100);
  assert.equal((await app.inject({url:done.videoUrl,headers:{...headers,range:'bytes=999999999-'}})).statusCode,416);
  const cached=new Pipeline(f.store,undefined);assert.equal((await cached.imageVideos.start(id)).state,'completed');assert.equal(f.videos,1);
});

test('lost submit response and restart reconcile external ID without a second paid request; downloads resume',async t=>{
  const {f,engine,id}=await setup(t);f.submitFail=true;
  await engine.imageVideos.start(id);await engine.idle();let failed=await f.store.get<ImageVideoRecord>('image-videos',id);
  assert.equal(failed.state,'failed');assert.equal(failed.canResume,true);assert.equal(failed.requestId,undefined);assert.equal(f.videos,1);assert.ok(!JSON.stringify(failed.error).includes('private'));
  f.empty=true;await engine.imageVideos.start(id);await engine.idle();assert.equal(f.videos,1);assert.equal((await f.store.get<ImageVideoRecord>('image-videos',id)).error?.code,'KLING_SUBMISSION_UNCERTAIN');
  // Crash during submission: initialize must query external ID, never POST again.
  failed=await f.store.get<ImageVideoRecord>('image-videos',id);failed.state='submitting';await f.store.save('image-videos',failed);
  f.empty=false;f.downloadFail=true;const restarted=new Pipeline(f.store,f.bria,5,30000,{},undefined,f.kling);await restarted.initialize();await restarted.idle();
  assert.equal((await f.store.get<ImageVideoRecord>('image-videos',id)).requestId,'kling-test');assert.equal(f.videos,1);
  f.downloadFail=false;await restarted.imageVideos.start(id);await restarted.idle();assert.equal((await f.store.get<ImageVideoRecord>('image-videos',id)).state,'completed');assert.equal(f.videos,1);assert.equal(f.whites,1);
});

test('Kling preflight, Bria-only input, terminal failure and region changes cannot create extra paid work',async t=>{
  const {f,engine,id}=await setup(t);
  const source=await f.store.get<ImageRecord>('image-jobs',id);source.meta.width=200;await f.store.save('image-jobs',source);
  await assert.rejects(engine.imageVideos.start(id),/300px/);assert.equal(f.whites,0);assert.equal(f.videos,0);
  source.meta.width=360;source.provider='tripo';await f.store.save('image-jobs',source);await assert.rejects(engine.imageVideos.start(id),/Bria/);
  source.provider='bria';await f.store.save('image-jobs',source);f.upstreamFailed=true;await engine.imageVideos.start(id);await engine.idle();
  assert.equal((await f.store.get<ImageVideoRecord>('image-videos',id)).canResume,false);await assert.rejects(engine.imageVideos.start(id));assert.equal(f.videos,1);
  const wrong=new Pipeline(f.store,f.bria,5,30000,{},undefined,{...f.kling,region:'global'});await assert.rejects(wrong.imageVideos.start(id),/区域/);assert.equal(f.videos,1);
});

test('Bria uncertain submission blocks Kling and cannot be resubmitted by video recovery',async t=>{
  const {f,engine,id}=await setup(t);
  let attempts=0;f.bria.imageForeground=async()=>{attempts++;throw new Error('private-bria-detail');};
  await engine.imageVideos.start(id);await engine.idle();
  const failed=await f.store.get<ImageVideoRecord>('image-videos',id);
  assert.equal(failed.state,'failed');assert.equal(failed.canResume,false);assert.equal(f.videos,0);assert.equal(attempts,1);
  assert.equal(failed.error?.code,'BRIA_WHITE_UNCERTAIN');assert.match(failed.error.message,/未取得任务号/);
  assert.doesNotMatch(failed.error.message,/private-bria-detail|请查看图片错误并恢复原任务/);
  await assert.rejects(engine.imageVideos.start(id));assert.equal(attempts,1);
});
