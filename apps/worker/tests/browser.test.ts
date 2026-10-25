import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
let mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,alice:string,bob:string,expired:string;
let submitted=0,forwarded=0,submitCode=202;
before(async()=>{
  const keys=await generateKeyPair('RS256'),jwk={...await exportJWK(keys.publicKey),kid:'test-key',alg:'RS256',use:'sig'};
  const sign=(sub:string,expiration='1h')=>new SignJWT({sub}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer('https://test-team.cloudflareaccess.com').setAudience('test-app').setIssuedAt().setExpirationTime(expiration).sign(keys.privateKey);
  alice=await sign('alice');bob=await sign('bob');expired=await sign('alice','-1h');
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'apps/worker/dist/index.js',compatibilityDate:'2026-07-30',d1Databases:['DB'],r2Buckets:['STAGING'],bindings:{ACCESS_TEAM_DOMAIN:'test-team.cloudflareaccess.com',ACCESS_AUD:'test-app',BRIA_API_TOKEN:'fake-bria',CUTOUT_CLOUD_TOKEN:'fake-legacy-token-at-least-32-characters',BRIA_MEDIA_HOSTS:'media.example.com',DEV_AUTH:'1'},outboundService:async request=>{
    const url=new URL(request.url);
    if(url.origin==='https://test-team.cloudflareaccess.com')return Response.json({keys:[jwk]});
    if(url.origin==='https://media.example.com') {
      if(request.method==='POST'){const text=await request.text();assert.match(text,/name="policy"/);assert.match(text,/name="file"/);forwarded++;return new Response(null,{status:204});}
      return new Response('result-video',{headers:{'Content-Length':'12'}});
    }
    assert.equal(url.origin,'https://engine.prod.bria-api.com','All upstream traffic must be mocked');
    if(url.pathname==='/v2/video/upload')return Response.json({result:{upload_url:'https://media.example.com/upload?private=secret',upload_fields:{key:'source.mp4',policy:'secret-policy'},file_url:'https://media.example.com/source?private=secret'}});
    if(url.pathname.startsWith('/v2/status/'))return Response.json({status:'COMPLETED',result:{mask_url:'https://media.example.com/mask?private=secret',video_url:'https://media.example.com/video?private=secret'}});
    submitted++;if(submitCode!==202)return new Response('private-body',{status:submitCode});
    return Response.json({request_id:'request-test-1234'},{status:202});
  }}));
  db=await mf.getD1Database('DB');
  for(const file of ['0001_tasks.sql','0002_browser.sql','0005_device_scope.sql'])for(const statement of (await readFile('apps/worker/migrations/'+file,'utf8')).split(';').filter(s=>s.trim()))await db.prepare(statement).run();
});
after(async()=>{await mf?.dispose();});
function call(path:string,body?:unknown,token=alice,method=body===undefined?'GET':'POST',extra:Record<string,string>={}) {
  const raw=body instanceof Uint8Array?body:body===undefined?undefined:JSON.stringify(body);
  return mf.dispatchFetch('https://app.example'+path,{method,headers:{'cf-access-jwt-assertion':token,'Origin':'https://app.example','X-Cutout-Client':'1','Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json',...extra},body:raw});
}
async function upload() {
  const created=await call('/browser/uploads',{size:16});assert.equal(created.status,201);
  const {uploadId}=await created.json() as {uploadId:string};
  assert.equal((await call(`/browser/uploads/${uploadId}/complete`,{})).status,409);
  assert.equal((await call(`/browser/uploads/${uploadId}/parts/1`,new Uint8Array(16),bob,'PUT',{'Content-Length':'16'})).status,404);
  assert.equal((await call(`/browser/uploads/${uploadId}/parts/1`,new Uint8Array(16),alice,'PUT',{'Content-Length':'16'})).status,200);
  const complete=await call(`/browser/uploads/${uploadId}/complete`,{});assert.equal(complete.status,200,await complete.clone().text());
  assert.doesNotMatch(await complete.text(),/private|secret|url|policy/);
  assert.equal(await (await mf.getR2Bucket('STAGING')).get('uploads/'+uploadId),null,'Completed staging file removed');
  assert.equal((await call(`/browser/uploads/${uploadId}/complete`,{})).status,200);
  return uploadId;
}
test('browser API validates Access signatures, expiration and same-origin writes; dev bypass cannot authorize public hosts',async()=>{
  assert.equal((await call('/browser/health',undefined,'')).status,401);
  assert.equal((await call('/browser/health',undefined,expired)).status,401);
  assert.equal((await call('/browser/health',undefined,alice.slice(0,-10)+'invalid')).status,401);
  assert.equal((await call('/browser/uploads',{size:16},alice,'POST',{Origin:'https://evil.example'})).status,403);
  assert.equal((await call('/browser/uploads',{size:16},alice,'POST',{'X-Cutout-Client':''})).status,403);
  const response=await call('/browser/health');assert.equal(response.status,200);assert.equal((await response.json() as {processingReady:boolean}).processingReady,true);
});
test('multipart transfer is owned, complete and streaming; job dedupe and result downloads never expose signed URLs',async()=>{
  const uploadId=await upload();assert.equal(forwarded,1);
  const input={cloudJobId:randomUUID(),uploadId,mode:'prompt',prompt:'person',meta:{width:320,height:180,duration:1,fps:24,frames:24}};
  assert.equal((await call('/browser/jobs',input,bob)).status,404);
  const responses=await Promise.all([call('/browser/jobs',input),call('/browser/jobs',input)]);
  for(const res of responses){assert.equal(res.status,202);assert.doesNotMatch(await res.text(),/private|secret|mask_url|video_url/);}
  assert.equal(submitted,1);
  assert.equal((await call('/browser/jobs',{...input,prompt:'other'})).status,409);
  assert.equal((await call('/browser/jobs/'+input.cloudJobId,undefined,bob)).status,404);
  assert.equal((await call('/browser/jobs/'+input.cloudJobId+'/artifact',undefined,bob)).status,404);
  await db.prepare('UPDATE jobs SET next_poll_at=0 WHERE id=?').bind(input.cloudJobId).run();
  const state=await call('/browser/jobs/'+input.cloudJobId),text=await state.text();assert.match(text,/completed/);assert.doesNotMatch(text,/private|secret|_url/);
  const artifact=await call('/browser/jobs/'+input.cloudJobId+'/artifact');assert.equal(await artifact.text(),'result-video');assert.equal(artifact.headers.get('location'),null);
  assert.equal(submitted,1);
});
test('upstream uncertain submission is persisted and repeated POST does not resubmit',async()=>{
  const uploadId=await upload(),start=submitted;submitCode=503;
  const input={cloudJobId:randomUUID(),uploadId,mode:'auto',meta:{width:320,height:180,duration:1,fps:24,frames:24}};
  assert.equal((await (await call('/browser/jobs',input)).json() as {state:string}).state,'uncertain');
  await call('/browser/jobs',input);assert.equal(submitted,start+1);submitCode=202;
});
test('multiple R2 parts enforce lengths and result proxy rejects an untrusted media host',async()=>{
  const size=8*1024*1024+16;
  const created=await call('/browser/uploads',{size});
  const {uploadId}=await created.json() as {uploadId:string};
  assert.equal((await call(`/browser/uploads/${uploadId}/parts/2`,new Uint8Array(15),alice,'PUT',{'Content-Length':'15'})).status,400);
  assert.equal((await call(`/browser/uploads/${uploadId}/parts/1`,new Uint8Array(8*1024*1024),alice,'PUT',{'Content-Length':String(8*1024*1024)})).status,200);
  assert.equal((await call(`/browser/uploads/${uploadId}/parts/2`,new Uint8Array(16),alice,'PUT',{'Content-Length':'16'})).status,200);
  const complete=await call(`/browser/uploads/${uploadId}/complete`,{});assert.equal(complete.status,200,await complete.clone().text());
  const id=randomUUID();
  await call('/browser/jobs',{cloudJobId:id,uploadId,mode:'auto',meta:{width:320,height:180,duration:1,fps:24,frames:24}});
  await db.prepare("UPDATE jobs SET state='completed',status_json=? WHERE id=?").bind(JSON.stringify({status:'COMPLETED',result:{video_url:'https://untrusted.invalid/private'}}),id).run();
  const denied=await call('/browser/jobs/'+id+'/artifact');assert.equal(denied.status,502);assert.doesNotMatch(await denied.text(),/untrusted|private/);
});


test('same-account devices isolate uploads, jobs and artifacts; missing header cannot bypass scope',async()=>{
  const a={'X-Cutout-Device':'dev_'+'a'.repeat(64)},b={'X-Cutout-Device':'dev_'+'b'.repeat(64)};
  const deviceCall=(path:string,body?:unknown,headers:Record<string,string>=a,method=body===undefined?'GET':'POST')=>call(path,body,alice,method,headers);
  assert.equal((await deviceCall('/browser/health',undefined,{'X-Cutout-Device':'invalid'})).status,400);
  const health=await (await deviceCall('/browser/health')).json() as {deviceIsolation:boolean;deviceId:string};
  assert.equal(health.deviceIsolation,true);assert.equal(health.deviceId,a['X-Cutout-Device']);
  const {uploadId}=await (await deviceCall('/browser/uploads',{size:16})).json() as {uploadId:string};
  for(const headers of [b,{}]) {
    assert.equal((await deviceCall(`/browser/uploads/${uploadId}/parts/1`,new Uint8Array(16),{...headers,'Content-Length':'16'},'PUT')).status,404);
    assert.equal((await deviceCall(`/browser/uploads/${uploadId}/complete`,{},headers)).status,404);
  }
  assert.equal((await deviceCall(`/browser/uploads/${uploadId}/parts/1`,new Uint8Array(16),{...a,'Content-Length':'16'},'PUT')).status,200);
  assert.equal((await deviceCall(`/browser/uploads/${uploadId}/complete`,{})).status,200);
  const input={cloudJobId:randomUUID(),uploadId,mode:'auto',meta:{width:320,height:180,duration:1,fps:24,frames:24}},start=submitted;
  assert.equal((await deviceCall('/browser/jobs',input,b)).status,404);
  assert.equal((await deviceCall('/browser/jobs',input)).status,202);
  for(const headers of [b,{}])for(const suffix of ['','/artifact'])assert.equal((await deviceCall('/browser/jobs/'+input.cloudJobId+suffix,undefined,headers)).status,404);
  assert.equal((await deviceCall('/browser/jobs/'+input.cloudJobId+'/claim-device',{},b)).status,404);
  assert.equal(submitted,start+1);
  await db.prepare('UPDATE jobs SET next_poll_at=0 WHERE id=?').bind(input.cloudJobId).run();
  assert.equal((await deviceCall('/browser/jobs/'+input.cloudJobId)).status,200);
  assert.equal(await (await deviceCall('/browser/jobs/'+input.cloudJobId+'/artifact')).text(),'result-video');
});

test('legacy task adoption is owner-checked, atomic, idempotent and never resubmits',async()=>{
  const id=randomUUID(),owner=(await (await call('/browser/health')).json() as {userId:string}).userId;
  await db.prepare("INSERT INTO browser_jobs(id,owner) VALUES(?,?)").bind(id,owner).run();
  const a={'X-Cutout-Device':'dev_'+'c'.repeat(64)},b={'X-Cutout-Device':'dev_'+'d'.repeat(64)},start=submitted;
  const path='/browser/jobs/'+id+'/claim-device';
  assert.equal((await call(path,{},bob,'POST',a)).status,404);
  assert.equal((await call(path,{})).status,400);
  const responses=await Promise.all([call(path,{},alice,'POST',a),call(path,{},alice,'POST',b)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,404]);
  const winner=responses[0].status===200?a:b;
  assert.equal((await call(path,{},alice,'POST',winner)).status,200);
  assert.equal((await call('/browser/jobs/'+id)).status,404);
  assert.equal(submitted,start,'migration cannot submit a paid request');
});
