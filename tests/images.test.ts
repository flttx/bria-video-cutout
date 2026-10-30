import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from '../apps/api/src/app.js';
import { BriaClient } from '../apps/api/src/bria/client.js';
import { command } from '../apps/api/src/media.js';
import { Pipeline } from '../apps/api/src/pipeline.js';
import { Store } from '../apps/api/src/store.js';
import { IMAGE_MAX_BYTES, type ImageRecord } from '../apps/api/src/images.js';
import { TripoClient, tripoSettings, type TripoImageGateway } from '../apps/api/src/tripo.js';

const token='synthetic-image-tests-password';
const origin='http://127.0.0.1:5197';
const headers={authorization:'Basic '+Buffer.from(`admin:${token}`).toString('base64'),origin,'x-cutout-client':'1'};
async function fixture() {
  const root=resolve('.tmp/image-tests',randomUUID());await mkdir(root,{recursive:true});
  const source=resolve(root,'source.png'),alpha=resolve(root,'alpha.png');
  await command('ffmpeg',['-y','-f','lavfi','-i','color=blue:s=34x26,format=rgba,drawbox=x=8:y=6:w=18:h=14:color=red:t=fill','-frames:v','1',source]);
  await command('ffmpeg',['-y','-i',source,'-vf','colorkey=blue:0.1:0.0','-frames:v','1',alpha]);
  return {root,source,alpha};
}
function gateway(alpha:string) {
  let submissions=0,downloads=0;let failure=false,hold=false,downloadFailure=false;
  return {
    get submissions(){return submissions;},get downloads(){return downloads;},
    set failure(value:boolean){failure=value;},set hold(value:boolean){hold=value;},set downloadFailure(value:boolean){downloadFailure=value;},
    upload:async()=>{throw new Error('Image must not use video upload');},
    autoForeground:async()=>{throw new Error('No video cutout');},
    maskByPrompt:async()=>{throw new Error('No video mask');},maskByPoints:async()=>{throw new Error('No video mask');},
    imageForeground:async(image:string)=>{submissions++;assert.equal(Buffer.from(image,'base64').subarray(1,4).toString(),'PNG');if(failure)throw new Error('private-provider-url');return {request_id:'image-request-test'};},
    status:async()=>({status:hold?'IN_PROGRESS' as const:'COMPLETED' as const,result:{image_url:'https://example.invalid/private-result'}}),
    download:async(_url:string,file:string)=>{downloads++;if(downloadFailure)throw new Error('private-download-url');await copyFile(alpha,file);},
  };
}

test('image workflow authenticates, deduplicates paid submissions, persists and produces actual white RGB PNG',async t=>{
  const f=await fixture(),provider=gateway(f.alpha),store=new Store(resolve(f.root,'data'));
  const engine=new Pipeline(store,provider,1,1000);
  const app=await createServer(engine,true,undefined,undefined,{origin,proxyToken:token,mode:'basic'});t.after(()=>app.close());
  assert.equal((await app.inject({url:'/api/images'})).statusCode,401);
  assert.equal((await app.inject({url:'/api/health',headers})).json().imageWhiteEnabled,true);
  const upload=await app.inject({method:'POST',url:'/api/images',headers:{...headers,'content-type':'application/octet-stream','x-video-filename':encodeURIComponent('产品.png')},payload:await readFile(f.source)});
  assert.equal(upload.statusCode,201,upload.body);const item=upload.json();assert.equal(item.state,'uploaded');assert.equal(provider.submissions,0);
  assert.equal((await app.inject({url:`/api/images/${item.id}/file`,headers})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url:`/api/images/${item.id}/process`,headers:{...headers,origin:'https://evil.example'},payload:{}})).statusCode,403);
  const results=await Promise.all([1,2,3].map(()=>app.inject({method:'POST',url:`/api/images/${item.id}/process`,headers,payload:{}})));
  assert.ok(results.every(result=>result.statusCode===202));await engine.idle();
  const done=(await app.inject({url:`/api/images/${item.id}`,headers})).json();assert.equal(done.state,'completed',JSON.stringify(done));
  assert.equal(provider.submissions,1);assert.equal(provider.downloads,1);
  const downloaded=await app.inject({url:done.downloadUrl+'?download=1',headers});assert.equal(downloaded.statusCode,200);assert.match(String(downloaded.headers['content-disposition']),/^attachment/);
  assert.equal(downloaded.rawPayload[25],2,'PNG is RGB, not transparent RGBA');
  const rgb=resolve(f.root,'white.rgb');await command('ffmpeg',['-y','-i',store.path('images',item.id,'white.png'),'-f','rawvideo','-pix_fmt','rgb24',rgb]);
  const pixels=await readFile(rgb);assert.deepEqual([...pixels.subarray(0,3)],[255,255,255]);
  const center=(13*34+17)*3;assert.deepEqual([...pixels.subarray(center,center+3)],[255,0,0]);
  const history=await app.inject({url:'/api/images',headers});assert.ok(!/private-result|requestId|submissionAttempted/.test(history.body));
  const restarted=new Pipeline(new Store(store.root),provider,1,1000);await restarted.initialize();await restarted.images.start(item.id);await restarted.idle();assert.equal(provider.submissions,1);
  const incomplete=await store.get<ImageRecord>('image-jobs',item.id);incomplete.state='composing';await store.save('image-jobs',incomplete);
  await restarted.initialize();await restarted.idle();assert.equal(provider.submissions,1);assert.equal(provider.downloads,1,'Reuse transparent cache after restart');
});

test('uncertain image submission cannot be repeated after restart; download recovery queries original task',async t=>{
  const f=await fixture(),provider=gateway(f.alpha),store=new Store(resolve(f.root,'data'));
  let engine=new Pipeline(store,provider,1,1000);const app=await createServer(engine,true,origin);t.after(()=>app.close());
  const upload=async()=> (await app.inject({method:'POST',url:'/api/images',headers:{...headers,'content-type':'application/octet-stream'},payload:await readFile(f.source)})).json();
  const first=await upload();provider.failure=true;await engine.images.start(first.id);await engine.idle();
  const failed=await store.get<ImageRecord>('image-jobs',first.id);assert.equal(failed.state,'failed');assert.equal(failed.canResume,false);assert.ok(!JSON.stringify(failed.error).includes('private-provider'));
  engine=new Pipeline(store,provider,1,1000);await engine.initialize();await assert.rejects(engine.images.start(first.id));assert.equal(provider.submissions,1);
  // Simulate the crash window after recording intent, before persisting the upstream response.
  failed.state='submitting';await store.save('image-jobs',failed);await engine.initialize();await engine.idle();
  assert.equal((await store.get<ImageRecord>('image-jobs',first.id)).error?.code,'SUBMISSION_UNCERTAIN');assert.equal(provider.submissions,1);
  provider.failure=false;provider.downloadFailure=true;const second=await upload();await engine.images.start(second.id);await engine.idle();
  assert.equal((await store.get<ImageRecord>('image-jobs',second.id)).canResume,true);assert.equal(provider.submissions,2);
  provider.downloadFailure=false;await engine.images.start(second.id);await engine.idle();
  assert.equal((await store.get<ImageRecord>('image-jobs',second.id)).state,'completed');assert.equal(provider.submissions,2);
});

test('image upload rejects spoofed, truncated, oversized and animated inputs before billing; unconfigured service is explicit',async t=>{
  const f=await fixture(),engine=new Pipeline(new Store(resolve(f.root,'data')),undefined);
  const app=await createServer(engine,false,origin);t.after(()=>app.close());
  const uploadHeaders={...headers,'content-type':'application/octet-stream','x-video-filename':'pretend.png'};
  for(const payload of [Buffer.from('not an image'),(await readFile(f.source)).subarray(0,22)])assert.ok((await app.inject({method:'POST',url:'/api/images',headers:uploadHeaders,payload})).statusCode>=400);
  assert.equal((await app.inject({method:'POST',url:'/api/images',headers:{...uploadHeaders,'content-length':String(IMAGE_MAX_BYTES+1)},payload:Buffer.from('x')})).statusCode,413);
  const huge=Buffer.from(await readFile(f.source));huge.writeUInt32BE(9000,16);await writeFile(resolve(f.root,'huge.png'),huge);
  assert.ok((await app.inject({method:'POST',url:'/api/images',headers:uploadHeaders,payload:huge})).statusCode>=400);
  const animated=resolve(f.root,'animated.png');await command('ffmpeg',['-y','-f','lavfi','-i','testsrc=s=32x24:r=2:d=1','-plays','0','-f','apng',animated]);
  assert.ok((await app.inject({method:'POST',url:'/api/images',headers:uploadHeaders,payload:await readFile(animated)})).statusCode>=400);
  const item=(await app.inject({method:'POST',url:'/api/images',headers:uploadHeaders,payload:await readFile(f.source)})).json();
  assert.equal((await app.inject({method:'POST',url:`/api/images/${item.id}/process`,headers,payload:{}})).statusCode,503);
});

test('Bria image protocol uses dedicated async endpoint and parses image result without leaking warning text',async()=>{
  let calls=0;
  const transport:typeof fetch=async(input,init)=>{
    calls++;assert.equal(new Headers(init?.headers).get('api_token'),'synthetic-key');
    if(init?.method==='POST') {
      assert.equal(String(input),'https://engine.prod.bria-api.com/v2/image/edit/remove_background');
      assert.deepEqual(JSON.parse(String(init.body)),{image:'image-base64',sync:false,preserve_alpha:true});
      return Response.json({request_id:'image-request'});
    }
    return Response.json({status:'COMPLETED',result:{image_url:'https://example.com/result.png',warning:'private-signed-url'}});
  };
  const client=new BriaClient('synthetic-key',transport);
  const submitted=await client.imageForeground('image-base64');const status=await client.status(submitted.request_id);
  assert.equal(status.result?.image_url,'https://example.com/result.png');assert.equal(status.result?.warning,true);assert.equal(calls,2);
});

test('Tripo API uses private upload, async image edit and task query with sanitized errors and no retry',async()=>{
  const f=await fixture();let calls=0;
  const client=new TripoClient('synthetic-tripo-key','china',async(input,init)=>{
    calls++;const url=String(input);
    assert.ok(url.startsWith('https://openapi.tripo3d.com/v3/'));assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-tripo-key');
    if(url.endsWith('/files')) {
      assert.ok(init?.body instanceof FormData);const file=init.body.get('file') as File;
      assert.equal(file.type,'image/png');assert.equal(file.name,'source.png');
      return Response.json({code:0,data:{file_token:'file_test'}});
    }
    if(url.endsWith('/generation/image-to-image')) {
      const body=JSON.parse(String(init?.body));assert.equal(body.input,'file_test');assert.equal(body.model,'seedream_v5');
      assert.match(body.prompt,/#FFFFFF/);assert.equal(body.output_format,'png');assert.equal(body.background,undefined);
      const [w,h]=body.size.split('x').map(Number);assert.ok(w*h>=3_690_000&&w*h<=10_400_000);assert.ok(Math.abs(w/h-34/26)<0.001);
      return Response.json({code:0,data:{task_id:'task_test'}});
    }
    assert.ok(url.endsWith('/tasks/task_test'));
    return Response.json({code:0,data:{task_id:'task_test',status:'success',output:{generated_image_url:'https://example.com/result.png'}}});
  });
  const uploaded=await client.upload(f.source),id=await client.submit(uploaded,{width:34,height:26});
  assert.equal((await client.status(id)).result?.image_url,'https://example.com/result.png');assert.equal(calls,3);
  for(const response of [()=>Response.json({code:999,message:'private-token'}),()=>new Response('private-token',{status:503}),()=>Response.json({code:0,data:{task_id:'../../private'}})]) {
    let count=0;const bad=new TripoClient('secret','global',async url=>{count++;assert.ok(String(url).startsWith('https://openapi.tripo3d.ai/'));return response();});
    await assert.rejects(bad.submit('file_test',{width:34,height:26}),error=>error instanceof Error&&!error.message.includes('private-token'));
    assert.equal(count,1);
  }
  const mismatch=new TripoClient('secret','china',async()=>Response.json({code:0,data:{task_id:'other',status:'success',output:{generated_image_url:'https://example.com/a'}}}));
  await assert.rejects(mismatch.status('task_test'));
  await assert.rejects(client.download('http://127.0.0.1/private','unused',1000),/Tripo/);assert.equal(calls,3,'unsafe download does not issue network request');
  assert.equal(tripoSettings({}),undefined);assert.throws(()=>tripoSettings({TRIPO_API_KEY:'key',TRIPO_API_REGION:'invalid'}));
});

test('provider switch is read-only, tasks deduplicate independently and Tripo accepts opaque resized output',async t=>{
  const f=await fixture(),bria=gateway(f.alpha),store=new Store(resolve(f.root,'data'));
  const storageErrors:string[]=[],save=store.save.bind(store);
  store.save=async(kind,value)=>{try{await save(kind,value);}catch(error){storageErrors.push(String((error as NodeJS.ErrnoException).code));throw error;}};
  const generated=resolve(f.root,'generated.png');await command('ffmpeg',['-y','-f','lavfi','-i','color=white:s=48x32','-frames:v','1',generated]);
  let submissions=0,uploads=0,downloadFailure=true;
  const tripo:TripoImageGateway={region:'china',upload:async()=>{uploads++;return 'file_mock';},submit:async()=>{submissions++;return 'task_mock';},
    status:async()=>({status:'COMPLETED',result:{image_url:'https://example.invalid/private'}}),download:async(_url,file)=>{if(downloadFailure)throw new Error('private-url');await copyFile(generated,file);}};
  const engine=new Pipeline(store,bria,1,1000,{},tripo),app=await createServer(engine,true,origin);t.after(()=>app.close());
  assert.deepEqual((await app.inject({url:'/api/health',headers})).json().imageWhiteProviders,{bria:true,tripo:true});
  const source=(await app.inject({method:'POST',url:'/api/images',headers:{...headers,'content-type':'application/octet-stream'},payload:await readFile(f.source)})).json();
  const variant=(await app.inject({url:`/api/images/${source.id}?provider=tripo`,headers})).json();
  assert.equal(variant.provider,'tripo');assert.equal(variant.sourceId,source.id);assert.notEqual(variant.id,source.id);assert.equal(uploads,0);assert.equal(submissions,0);
  assert.equal((await store.list('image-jobs')).length,1,'switch does not persist a task');
  assert.equal((await app.inject({method:'POST',url:`/api/images/${source.id}/process`,headers,payload:{provider:'unknown'}})).statusCode,400);
  await engine.images.start(source.id,'bria');await engine.idle();
  const results=await Promise.all([1,2,3].map(()=>app.inject({method:'POST',url:`/api/images/${source.id}/process`,headers,payload:{provider:'tripo'}})));
  assert.ok(results.every(r=>r.statusCode===202));await engine.idle();
  const failed=await engine.images.get(source.id,'tripo');assert.deepEqual(storageErrors,[]);assert.equal(failed.canResume,true);assert.equal(submissions,1);assert.equal(uploads,1);assert.equal(bria.submissions,1);
  downloadFailure=false;const restarted=new Pipeline(store,bria,1,1000,{},tripo);await restarted.initialize();await restarted.images.start(source.id,'tripo');await restarted.idle();
  const done=await restarted.images.get(source.id,'tripo');assert.equal(done.state,'completed');assert.equal(done.outputMeta?.width,48);assert.equal(done.outputMeta?.height,32);assert.equal(submissions,1);
  const cached=(await app.inject({url:`/api/images/${source.id}?provider=bria`,headers})).json();assert.equal(cached.id,source.id);assert.equal(cached.state,'completed');
  assert.equal((await app.inject({url:`/api/images/${done.id}/source`,headers})).statusCode,200);
  const file=await app.inject({url:`/api/images/${done.id}/file?download=1`,headers});assert.equal(file.statusCode,200);assert.equal(file.rawPayload[25],2);
  assert.notDeepEqual(file.rawPayload,(await app.inject({url:cached.downloadUrl,headers})).rawPayload);
  const history=await app.inject({url:'/api/images',headers});assert.equal(history.json().length,2);assert.ok(!/file_mock|task_mock|private|region|seedream/.test(history.body));
  const noKeys=new Pipeline(store,undefined);await noKeys.images.start(source.id,'tripo');assert.equal(submissions,1,'completed tasks remain readable without keys');
});

test('Tripo uncertain submission survives restart, region cannot change and no provider fallback occurs',async t=>{
  const f=await fixture(),bria=gateway(f.alpha),store=new Store(resolve(f.root,'data'));let submissions=0,uploads=0;
  const tripo:TripoImageGateway={region:'china',upload:async()=>{uploads++;return 'file_mock';},submit:async()=>{submissions++;throw new Error('private-key');},
    status:async()=>({status:'ERROR'}),download:async()=>{throw new Error('unused');}};
  const engine=new Pipeline(store,bria,1,1000,{},tripo),app=await createServer(engine,true,origin);t.after(()=>app.close());
  const source=(await app.inject({method:'POST',url:'/api/images',headers:{...headers,'content-type':'application/octet-stream'},payload:await readFile(f.source)})).json();
  await engine.images.start(source.id,'tripo');await engine.idle();const failed=await engine.images.get(source.id,'tripo');
  assert.equal(failed.canResume,false);assert.ok(!JSON.stringify(failed.error).includes('private-key'));assert.equal(bria.submissions,0);
  const restarted=new Pipeline(store,bria,1,1000,{},tripo);await restarted.initialize();await assert.rejects(restarted.images.start(source.id,'tripo'));
  failed.state='submitting';await store.save('image-jobs',failed);await restarted.initialize();await restarted.idle();
  assert.equal((await restarted.images.get(source.id,'tripo')).error?.code,'SUBMISSION_UNCERTAIN');assert.equal(submissions,1);assert.equal(uploads,1);
  const changed=new Pipeline(store,bria,1,1000,{}, {...tripo,region:'global'});await assert.rejects(changed.images.start(source.id,'tripo'),/区域/);
  const disabled=new Pipeline(store,bria);await assert.rejects(disabled.images.start(source.id,'tripo'),/尚未配置/);assert.equal(bria.submissions,0);
  const narrow=resolve(f.root,'narrow.png');await command('ffmpeg',['-y','-f','lavfi','-i','color=white:s=100x20','-frames:v','1',narrow]);
  const invalid=(await app.inject({method:'POST',url:'/api/images',headers:{...headers,'content-type':'application/octet-stream'},payload:await readFile(narrow)})).json();
  await assert.rejects(engine.images.start(invalid.id,'tripo'),/宽高比/);assert.equal(uploads,1);
});

test('private server packaging carries optional Tripo and Kling settings without printing credentials',async()=>{
  const root=resolve('.tmp/image-config-tests',randomUUID());await mkdir(root,{recursive:true});
  const source=resolve(root,'input.env'),output=resolve(root,'private');
  await writeFile(source,'BRIA_API_TOKEN=synthetic-bria-secret\nTRIPO_API_KEY=synthetic-tripo-secret\nTRIPO_API_REGION=global\nKLING_API_KEY=synthetic-kling-secret\nKLING_API_REGION=global\n');
  const result=await promisify(execFile)(process.execPath,['deploy/standalone/prepare-private.mjs',output,source]);
  const config=await readFile(resolve(output,'api.env'),'utf8');
  assert.match(config,/TRIPO_API_KEY="synthetic-tripo-secret"/);assert.match(config,/TRIPO_API_REGION=global/);
  assert.match(config,/KLING_API_KEY="synthetic-kling-secret"/);assert.match(config,/KLING_API_REGION=global/);
  assert.ok(!/synthetic-(bria|tripo|kling)-secret/.test(result.stdout+result.stderr));
  const environmentOutput=resolve(root,'environment');
  const environmentResult=await promisify(execFile)(process.execPath,['deploy/standalone/prepare-private.mjs',environmentOutput],{
    env:{...process.env,BRIA_API_TOKEN:'synthetic-env-bria',TRIPO_API_KEY:'synthetic-env-tripo',TRIPO_API_REGION:'global',KLING_API_KEY:'synthetic-env-kling',KLING_API_REGION:'china'},
  });
  const environmentConfig=await readFile(resolve(environmentOutput,'api.env'),'utf8');
  assert.match(environmentConfig,/BRIA_API_TOKEN="synthetic-env-bria"/);
  assert.match(environmentConfig,/TRIPO_API_KEY="synthetic-env-tripo"/);
  assert.match(environmentConfig,/TRIPO_API_REGION=global/);
  assert.match(environmentConfig,/KLING_API_KEY="synthetic-env-kling"/);assert.match(environmentConfig,/KLING_API_REGION=china/);
  assert.ok(!/synthetic-env-(bria|tripo|kling)/.test(environmentResult.stdout+environmentResult.stderr));
  const invalid=resolve(root,'invalid.env');await writeFile(invalid,'BRIA_API_TOKEN=synthetic-bria-secret\nTRIPO_API_KEY=synthetic-tripo-secret\nTRIPO_API_REGION=unknown\n');
  await assert.rejects(promisify(execFile)(process.execPath,['deploy/standalone/prepare-private.mjs',resolve(root,'invalid'),invalid]),error=>error instanceof Error&&!error.message.includes('synthetic-tripo-secret'));
  await writeFile(invalid,'BRIA_API_TOKEN=synthetic-bria-secret\nKLING_API_KEY=synthetic-kling-secret\nKLING_API_REGION=unknown\n');
  await assert.rejects(promisify(execFile)(process.execPath,['deploy/standalone/prepare-private.mjs',resolve(root,'invalid-kling'),invalid]),error=>error instanceof Error&&!error.message.includes('synthetic-kling-secret'));
});
