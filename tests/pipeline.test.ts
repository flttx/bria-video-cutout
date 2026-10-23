import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, copyFile, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pipeline, jobView } from '../apps/api/src/pipeline.js';
import { Store } from '../apps/api/src/store.js';
import { command, probe, prepare, proxy, render } from '../apps/api/src/media.js';
import { AppError } from '../apps/api/src/errors.js';
import { parseJob } from '../apps/api/src/model.js';
import type { JobRecord, VideoRecord, ExportRecord } from '../apps/api/src/model.js';
import { BriaClient } from '../apps/api/src/bria/client.js';
import type { BriaGateway } from '../apps/api/src/bria/client.js';
import { createServer } from '../apps/api/src/app.js';

const root=resolve('.tmp','pipeline-tests',randomUUID());
const source=resolve(root,'source.mp4'),mask=resolve(root,'mask.mp4'),alpha=resolve(root,'alpha.webm');
before(async()=>{
  await mkdir(root,{recursive:true});
  await command('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x180:r=24:d=1','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-vf','drawbox=x=100:y=30:w=100:h=120:color=red:t=fill','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
  await command('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=320x180:r=24:d=1','-vf','drawbox=x=100:y=30:w=100:h=120:color=white:t=fill','-c:v','libx264','-pix_fmt','yuv420p',mask]);
  await command('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x180:r=24:d=1','-vf','drawbox=x=100:y=30:w=100:h=120:color=red:t=fill,format=rgba,colorkey=blue:0.1:0.0','-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0',alpha]);
});
class FakeBria implements BriaGateway {
  submissions=0;uploads=0;kind='mask';failSubmit=false;failPoll=false;lastPoints:unknown;lastFrame=-1;
  async upload(){this.uploads++;return 'https://example.invalid/private-signed-url';}
  async autoForeground(_v:string,color?:string){this.kind=color?'direct':'alpha';return this.submit();}
  async maskByPrompt(){this.kind='mask';return this.submit();}
  async maskByPoints(_v:string,frame:number,points:unknown){this.kind='mask';this.lastFrame=frame;this.lastPoints=points;return this.submit();}
  async submit(){this.submissions++;if(this.failSubmit)throw new AppError('BRIA_NETWORK','提交网络中断');return {request_id:'request-test-12345'};}
  async status(){if(this.failPoll)throw new AppError('TEST_POLL','测试查询失败');return {status:'COMPLETED' as const,result:{mask_url:'https://example.invalid/private-mask',video_url:'https://example.invalid/private-video'}};}
  async download(_url:string,path:string){await copyFile(this.kind==='alpha'?alpha:this.kind==='direct'?source:mask,path);}
}
async function fixture() {
  const store=new Store(resolve(root,randomUUID())),bria=new FakeBria();
  const video:VideoRecord={id:randomUUID(),meta:await probe(source),bytes:1000,createdAt:new Date().toISOString(),filename:'原视频_测试.mp4'};
  await store.save('videos',video);await copyFile(source,store.path('videos',video.id,'source'));
  const engine=new Pipeline(store,bria,1,2000);
  const input={id:randomUUID(),videoId:video.id,mode:'prompt',prompt:'red rectangle',points:[],start:0,end:1,color:'White',resolution:'source',reusable:true};
  return {store,bria,video,engine,input};
}

test('server validates limits and same-frame points before calling Bria',async()=>{
  const {engine,input,bria,video}=await fixture();
  await assert.rejects(engine.create({...input,end:6}),/裁选|最多/);
  await assert.rejects(engine.create({...input,color:'#ff0000'}),/预设/);
  await assert.rejects(engine.create({...input,mode:'points',points:[{x:.2,y:.2,type:'positive',atSeconds:.1},{x:.3,y:.3,type:'negative',atSeconds:.5}]}),/同一帧/);
  assert.throws(()=>parseJob({...input,mode:'prompt',start:0,end:6},{...video.meta,duration:10}),/最多处理 5/);
  assert.throws(()=>parseJob({...input,resolution:'2K'},video.meta),/不支持指定/);
  assert.equal(parseJob({...input,resolution:undefined},video.meta).resolution,'source');
  assert.equal(bria.submissions,0);
});
test('mask pipeline, duplicate POST, audio, background recolor and validated export',async()=>{
  const {engine,input,bria,store,video}=await fixture();
  const [a,b]=await Promise.all([engine.create(input),engine.create(input)]);assert.equal(a.id,b.id);
  await engine.idle();
  const job=await store.get<JobRecord>('jobs',a.id);assert.equal(job.state,'completed',JSON.stringify(job.error));assert.equal(bria.submissions,1);
  const first=await store.get<ExportRecord>('exports',job.exportId!);
  assert.equal(first.route,'mask_composite');assert.equal(first.meta?.width,320);assert.equal(first.meta?.hasAudio,true);assert.equal(first.meta?.frames,24);assert.equal(first.meta?.height,180);assert.equal(first.meta?.fps,24);
  await assert.rejects(engine.createExport(job.id,{id:randomUUID(),color:'Blue',resolution:'4K'}),/不支持指定/);
  const id=randomUUID();await engine.createExport(job.id,{id,color:'Blue',resolution:'source'});await engine.idle();
  const second=await store.get<ExportRecord>('exports',id);assert.equal(second.state,'completed',JSON.stringify(second.error));assert.equal(second.meta?.width,320);assert.equal(bria.submissions,1);
  const response=JSON.stringify(jobView(job));assert.ok(!response.includes('request-test'));assert.ok(!response.includes('https:'));assert.ok(!response.includes(root));
  const app=await createServer(engine,true);const history=await app.inject({url:'/api/jobs'});assert.equal(history.statusCode,200);assert.equal(history.json()[0].id,job.id);assert.equal(history.json()[0].latestExport.id,id);
  assert.equal(history.json()[0].filename,video.filename);assert.equal(history.json()[0].videoDuration,1);
  const detail=await app.inject({url:`/api/jobs/${job.id}`});assert.equal(detail.json().filename,video.filename);assert.equal(detail.json().videoDuration,1);
  const failedAttempt={...second,id:randomUUID(),state:'failed' as const,color:'Red' as const,createdAt:new Date(Date.now()+1000).toISOString(),error:{code:'TEST_EXPORT',message:'测试本地导出失败'}};
  await store.save('exports',failedAttempt);
  const updatedHistory=(await app.inject({url:'/api/jobs'})).json()[0];
  assert.equal(updatedHistory.latestAttempt.id,failedAttempt.id);assert.equal(updatedHistory.latestAttempt.state,'failed');
  assert.equal(updatedHistory.latestExport.id,id,'A failed recolor does not replace the playable result');
  const thumbnail=await app.inject({url:`/api/jobs/${job.id}/thumbnail`});assert.equal(thumbnail.statusCode,200);assert.match(thumbnail.headers['content-type'] as string,/image\/jpeg/);assert.deepEqual(thumbnail.rawPayload.subarray(0,2),Buffer.from([0xff,0xd8]));
  const range=await app.inject({url:`/api/exports/${id}/file`,headers:{range:'bytes=0-15'}});assert.equal(range.statusCode,206);assert.equal(range.rawPayload.length,16);assert.match(range.headers['content-range'] as string,/^bytes 0-15\//);
  assert.equal((await app.inject({url:`/api/exports/${id}/file`,headers:{range:'bytes=999999999-'}})).statusCode,416);
  await unlink(store.path('videos',video.id));
  const missingSource=await app.inject({url:'/api/jobs'});assert.equal(missingSource.statusCode,200);
  assert.equal(missingSource.json()[0].filename,undefined);assert.equal(missingSource.json()[0].latestExport.id,id);
  await app.close();
});
test('alpha decoded with transparency; exports include source audio',async()=>{
  const {engine,input,store}=await fixture();await engine.create({...input,mode:'auto'});await engine.idle();
  const job=await store.get<JobRecord>('jobs',input.id);assert.equal(job.state,'completed',JSON.stringify(job.error));
  assert.equal((await store.get<ExportRecord>('exports',job.exportId!)).route,'alpha_composite');
});
test('direct results preserve source size but cannot silently recolor',async()=>{
  const {engine,input,store}=await fixture();await engine.create({...input,mode:'auto',reusable:false});await engine.idle();
  const job=await store.get<JobRecord>('jobs',input.id);assert.equal(job.state,'completed',JSON.stringify(job.error));
  assert.equal((await store.get<ExportRecord>('exports',job.exportId!)).route,'direct_bria_mp4');
  await assert.rejects(engine.createExport(job.id,{id:randomUUID(),color:'Red',resolution:'source'}),/未缓存透明/);
});
test('point mapping uses normalized coordinates and clip-relative frame',async()=>{
  const {engine,input,bria,store}=await fixture();
  await engine.create({...input,mode:'points',points:[{x:1,y:1,type:'positive',atSeconds:.5}]});await engine.idle();
  const job=await store.get<JobRecord>('jobs',input.id);assert.equal(job.state,'completed',JSON.stringify(job.error));
  assert.equal(bria.lastFrame,12);assert.deepEqual(bria.lastPoints,[{x:319,y:179,type:'positive'}]);
});
test('query failure and restart recover the accepted request without resubmission',async()=>{
  const {engine,input,bria,store}=await fixture();bria.failPoll=true;await engine.create(input);await engine.idle();
  let job=await store.get<JobRecord>('jobs',input.id);assert.equal(job.state,'failed');assert.equal(job.canResume,true);
  bria.failPoll=false;
  const restarted=new Pipeline(store,bria,1,2000);await restarted.resume(job.id);await restarted.idle();
  job=await store.get<JobRecord>('jobs',input.id);assert.equal(job.state,'completed',JSON.stringify(job.error));assert.equal(bria.submissions,1);assert.equal(bria.uploads,1);
});
test('ambiguous submit is never automatically retried after restart',async()=>{
  const {engine,input,bria,store}=await fixture();bria.failSubmit=true;await engine.create(input);await engine.idle();
  const job=await store.get<JobRecord>('jobs',input.id);assert.equal(job.error?.code,'SUBMISSION_UNCERTAIN');assert.equal(job.canResume,false);
  job.state='submitting';await store.save('jobs',job);
  const restarted=new Pipeline(store,bria,1,2000);await restarted.initialize();await restarted.idle();assert.equal(bria.submissions,1);
  await assert.rejects(restarted.resume(job.id),/不能自动恢复/);
});
test('local HTTP upload probes content, blocks cross-origin POST and hides errors',async()=>{
  const {engine}=await fixture();const app=await createServer(engine,true);
  const payload=await readFile(source);
  assert.equal((await app.inject({method:'POST',url:'/api/videos',headers:{'content-type':'application/octet-stream'},payload})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/videos',headers:{'content-type':'application/octet-stream','x-cutout-client':'1',origin:'https://evil.invalid'},payload})).statusCode,403);
  const response=await app.inject({method:'POST',url:'/api/videos',headers:{'content-type':'application/octet-stream','x-cutout-client':'1','x-video-filename':encodeURIComponent('测试视频.mp4')},payload});assert.equal(response.statusCode,201,response.body);assert.equal(response.json().meta.width,320);assert.equal(response.json().filename,'测试视频.mp4');
  const videoId=response.json().id;const metadata=await app.inject({url:`/api/videos/${videoId}`});assert.equal(metadata.statusCode,200);assert.equal(metadata.json().filename,'测试视频.mp4');
  const sourceRange=await app.inject({url:`/api/videos/${videoId}/file`,headers:{range:'bytes=0-15'}});assert.equal(sourceRange.statusCode,206);assert.equal(sourceRange.rawPayload.length,16);
  const bad=await app.inject({method:'POST',url:'/api/videos',headers:{'content-type':'application/octet-stream','x-cutout-client':'1'},payload:Buffer.from('not a video')});assert.equal(bad.statusCode,422);assert.ok(!bad.body.includes(root));
  await app.close();
});
test('Bria client sends documented parameters and does not retry POST',async()=>{
  const calls:{url:string;body:Record<string,unknown>}[]=[];
  const transport:typeof fetch=async(url,options)=>{calls.push({url:String(url),body:JSON.parse(String(options?.body??'{}')) as Record<string,unknown>});return new Response(JSON.stringify({request_id:'accepted-1234',status_url:'https://should-not-be-trusted.invalid'}),{status:202});};
  const client=new BriaClient('test-secret',transport);
  await client.autoForeground('https://media.invalid');assert.equal(calls[0]!.body.background_color,'Transparent');assert.equal(calls[0]!.body.output_container_and_codec,'webm_vp9');
  await client.maskByPrompt('https://media.invalid','person');assert.equal(calls[1]!.body.auto_trim,false);
  let count=0;const rejected=new BriaClient('test-secret',async()=>{count++;return new Response('private upstream data',{status:403});});await assert.rejects(rejected.autoForeground('https://media.invalid'),/账号无此接口权限/);assert.equal(count,1);
});

test('exact-spec MP4 export is copied without re-encoding',async()=>{
  const meta=await probe(source,true);
  const first=resolve(root,'direct-2k.mp4');
  await render(source,source,'direct',first,{color:'White',resolution:'source'},meta);
  const second=resolve(root,'direct-copy.mp4');
  const result=await render(source,first,'direct',second,{color:'White',resolution:'source'},meta);
  assert.equal(result.route,'direct_bria_mp4');
  assert.deepEqual(await readFile(first),await readFile(second));
});
test('cropped source and proxy retain matching frame count and audio duration',async()=>{
  const meta=await probe(source,true),id=randomUUID();
  const options=parseJob({videoId:id,mode:'prompt',prompt:'person',start:.25,end:.75,color:'White',resolution:'source'},meta);
  const clipped=resolve(root,'clipped.mp4'),small=resolve(root,'proxy.mp4');
  const clipMeta=await prepare(source,clipped,options,meta),proxyMeta=await proxy(clipped,small);
  assert.equal(clipMeta.frames,12);assert.equal(proxyMeta.frames,12);assert.equal(clipMeta.hasAudio,true);assert.equal(proxyMeta.hasAudio,false);assert.equal(clipMeta.duration,.5);
});
test('Matroska uppercase alpha metadata is recognized',async()=>{
  const file=resolve(root,'alpha.mkv');
  await command('ffmpeg',['-hide_banner','-loglevel','error','-i',alpha,'-c','copy',file]);
  const meta=await probe(file);assert.equal(meta.alpha,true);
});

test('source-sized export preserves portrait, square and odd-sized display geometry',async()=>{
  for(const [width,height] of [[180,320],[256,256],[321,181]]) {
    const original=resolve(root,`geometry-${width}x${height}.mp4`),prepared=resolve(root,`prepared-${width}x${height}.mp4`),output=resolve(root,`output-${width}x${height}.mp4`);
    await command('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',`testsrc=s=${width}x${height}:r=30:d=0.5`,'-c:v','libx264','-pix_fmt','yuv444p',original]);
    const originalMeta=await probe(original,true);
    const options=parseJob({videoId:randomUUID(),mode:'auto',start:0,end:.5,color:'White'},originalMeta);
    const preparedMeta=await prepare(original,prepared,options,originalMeta);
    const result=await render(prepared,prepared,'direct',output,options,preparedMeta);
    assert.equal(result.meta.width,Math.ceil(width/2)*2);assert.equal(result.meta.height,Math.ceil(height/2)*2);
    assert.equal(result.meta.fps,30);assert.equal(result.meta.frames,15);assert.equal(result.meta.hasAudio,false);
  }
});

test('rotated anamorphic source exports its display dimensions and source frame rate',async()=>{
  const anamorphic=resolve(root,'anamorphic.mp4'),rotated=resolve(root,'rotated.mp4'),prepared=resolve(root,'rotated-prepared.mp4');
  await command('ffmpeg',['-hide_banner','-loglevel','error','-i',source,'-vf','setsar=2/1','-c:v','libx264','-c:a','copy',anamorphic]);
  await command('ffmpeg',['-hide_banner','-loglevel','error','-display_rotation','90','-i',anamorphic,'-c','copy',rotated]);
  const meta=await probe(rotated,true);assert.equal(meta.width,180);assert.equal(meta.height,640);
  const options=parseJob({videoId:randomUUID(),mode:'auto',start:0,end:1,color:'White'},meta);
  const result=await prepare(rotated,prepared,options,meta);
  assert.equal(result.width,180);assert.equal(result.height,640);assert.equal(result.fps,24);assert.equal(result.frames,24);
});

test('legacy cached artifacts can be exported at source size without new AI',async()=>{
  const {engine,input,store,bria}=await fixture();
  await engine.create(input);await engine.idle();
  const job=await store.get<JobRecord>('jobs',input.id);
  job.input.resolution='4K';await store.save('jobs',job);
  const id=randomUUID();await engine.createExport(job.id,{id,color:'Blue'});await engine.idle();
  const output=await store.get<ExportRecord>('exports',id);
  assert.equal(output.state,'completed');assert.equal(output.resolution,'source');assert.equal(output.meta?.width,320);assert.equal(output.meta?.height,180);assert.equal(bria.submissions,1);
  assert.deepEqual(jobView(job).sourceMeta,{width:320,height:180,fps:24});
});

test('full-range 8-second input exports a 5-second clip with limited-range pixels and metadata',async()=>{
  const original=resolve(root,'full-range.mp4'),prepared=resolve(root,'full-range-clip.mp4'),clipMask=resolve(root,'five-second-mask.mp4');
  await command('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=320x180:r=24:d=8','-vf','drawbox=x=160:y=0:w=160:h=180:color=white:t=fill,scale=out_range=pc','-c:v','libx264','-pix_fmt','yuv420p','-color_range','pc',original]);
  const originalMeta=await probe(original,true);
  assert.equal(originalMeta.pixelFormat,'yuvj420p');
  const options=parseJob({videoId:randomUUID(),mode:'prompt',prompt:'white rectangle',start:0,end:5,color:'White'},originalMeta);
  const clipMeta=await prepare(original,prepared,options,originalMeta);
  assert.equal(clipMeta.frames,120);
  await command('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=white:s=320x180:r=24:d=5','-c:v','libx264','-pix_fmt','yuv420p',clipMask]);
  for(const kind of ['mask','direct'] as const) {
    const output=resolve(root,`full-range-${kind}.mp4`);
    const result=await render(prepared,kind==='mask'?clipMask:prepared,kind,output,options,clipMeta);
    assert.equal(result.meta.pixelFormat,'yuv420p');assert.equal(result.meta.frames,120);
    assert.equal(result.meta.duration,5);assert.equal(result.meta.fps,24);
    assert.equal(result.meta.width,320);assert.equal(result.meta.height,180);assert.equal(result.meta.hasAudio,false);
    const stream=JSON.parse(await command('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=color_range','-of','json',output]));
    // H.264 may omit the default limited-range flag; it must never signal full range.
    assert.notEqual(stream.streams[0].color_range,'pc');
    // Check actual pixel conversion, not just relabeling full-range values as limited range.
    const levels=await command('ffmpeg',['-hide_banner','-loglevel','error','-i',output,'-vf','signalstats,metadata=print:file=-','-frames:v','1','-f','null','-']);
    assert.match(levels,/lavfi\.signalstats\.YMIN=16\r?\n/);
    assert.match(levels,/lavfi\.signalstats\.YMAX=235\r?\n/);
  }
});

test('task removal persists, keeps files, supports undo and blocks active work',async()=>{
  const {engine,input,store,bria,video}=await fixture();
  await engine.create(input);
  await assert.rejects(engine.setHistoryRemoved(input.id,true),/正在处理或导出/);
  await engine.idle();
  const app=await createServer(engine,true);
  const post=(action:string)=>app.inject({method:'POST',url:`/api/jobs/${input.id}/${action}`,headers:{'x-cutout-client':'1'}});
  const original=await readFile(store.path('exports',input.id,'output.mp4'));
  assert.equal((await app.inject({method:'POST',url:`/api/jobs/${input.id}/remove`})).statusCode,403);
  assert.equal((await post('remove')).statusCode,200);
  assert.equal((await post('remove')).statusCode,200,'Removal is idempotent');
  assert.equal((await app.inject({url:'/api/jobs'})).json().length,0);
  assert.ok((await new Store(store.root).get<JobRecord>('jobs',input.id)).removedAt);
  assert.deepEqual(await readFile(store.path('exports',input.id,'output.mp4')),original);
  assert.equal((await store.get<VideoRecord>('videos',video.id)).id,video.id);
  assert.equal((await app.inject({url:`/api/exports/${input.id}/file`,headers:{range:'bytes=0-15'}})).statusCode,206);
  assert.equal((await post('undo-remove')).statusCode,200);
  assert.equal((await app.inject({url:'/api/jobs'})).json()[0].id,input.id);
  const exportId=randomUUID();
  await engine.createExport(input.id,{id:exportId,color:'Blue'});
  await assert.rejects(engine.setHistoryRemoved(input.id,true),/正在处理或导出/);
  await engine.idle();
  await engine.setHistoryRemoved(input.id,true);
  await engine.createExport(input.id,{id:randomUUID(),color:'Red'});
  assert.equal((await store.get<JobRecord>('jobs',input.id)).removedAt,undefined,'Re-export restores visibility for progress');
  await engine.idle();
  const failed=await store.get<JobRecord>('jobs',input.id);failed.state='failed';failed.canResume=true;await store.save('jobs',failed);
  await engine.setHistoryRemoved(input.id,true);
  await engine.resume(input.id);await engine.idle();
  assert.equal((await store.get<JobRecord>('jobs',input.id)).removedAt,undefined);
  assert.equal(bria.submissions,1,'Removal, undo and cached recovery do not create AI tasks');
  assert.equal((await app.inject({method:'POST',url:'/api/jobs/invalid/remove',headers:{'x-cutout-client':'1'}})).statusCode,400);
  await app.close();
});
