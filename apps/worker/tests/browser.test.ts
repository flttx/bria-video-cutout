import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
let mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,alice:string,bob:string,expired:string;
let submitted=0,forwarded=0,submitCode=202,mediaRequests=0,lastMediaType='',lastMultipart='';
before(async()=>{
  const keys=await generateKeyPair('RS256'),jwk={...await exportJWK(keys.publicKey),kid:'test-key',alg:'RS256',use:'sig'};
  const sign=(sub:string,expiration='1h')=>new SignJWT({sub}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer('https://test-team.cloudflareaccess.com').setAudience('test-app').setIssuedAt().setExpirationTime(expiration).sign(keys.privateKey);
  alice=await sign('alice');bob=await sign('bob');expired=await sign('alice','-1h');
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'apps/worker/dist/index.js',compatibilityDate:'2026-07-30',d1Databases:['DB'],r2Buckets:['STAGING'],bindings:{ACCESS_TEAM_DOMAIN:'test-team.cloudflareaccess.com',ACCESS_AUD:'test-app',BRIA_API_TOKEN:'fake-bria',CUTOUT_CLOUD_TOKEN:'fake-legacy-token-at-least-32-characters',BRIA_MEDIA_HOSTS:'media.example.com',DEV_AUTH:'1'},outboundService:async request=>{
    const url=new URL(request.url);
    if(url.origin==='https://test-team.cloudflareaccess.com')return Response.json({keys:[jwk]});
    if(url.origin==='https://media.example.com') {
      if(request.method==='POST'){const text=await request.text();lastMultipart=text;assert.match(text,/name="policy"/);assert.match(text,/name="file"/);forwarded++;return new Response(null,{status:204});}
      const range=/^bytes=(\d+)-$/.exec(request.headers.get('range')??'');mediaRequests++;
      if(range){const start=Number(range[1]);if(start>=12)return new Response(null,{status:416});return new Response('result-video'.slice(start),{status:206,headers:{'Content-Length':String(12-start),'Content-Range':`bytes ${start}-11/12`}});}
      return new Response('result-video',{headers:{'Content-Length':'12'}});
    }
    assert.equal(url.origin,'https://engine.prod.bria-api.com','All upstream traffic must be mocked');
    if(url.pathname==='/v2/video/upload'){lastMediaType=(await request.json() as {media_type:string}).media_type;return Response.json({result:{upload_url:'https://media.example.com/upload?private=secret',upload_fields:{key:'source.mp4',policy:'secret-policy'},file_url:'https://media.example.com/source?private=secret'}});}
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
test('original video MIME survives R2 multipart and Bria upload grant; unsupported types are rejected',async()=>{
  const before=submitted;
  for(const [extension,mediaType] of [['mp4','video/mp4'],['mov','video/quicktime'],['webm','video/webm'],['avi','video/x-msvideo']]) {
    const created=await call('/browser/uploads',{size:16,mediaType});assert.equal(created.status,201);
    const {uploadId}=await created.json() as {uploadId:string};
    assert.equal((await call(`/browser/uploads/${uploadId}/parts/1`,new Uint8Array(16),alice,'PUT',{'Content-Length':'16'})).status,200);
    assert.equal((await call(`/browser/uploads/${uploadId}/complete`,{})).status,200);
    assert.equal(lastMediaType,mediaType);
    assert.ok(lastMultipart.includes(`filename="video.${extension}"\r\nContent-Type: ${mediaType}\r\n`));
  }
  for(const mediaType of ['text/html','video/mp4\r\nInjected: yes',42])assert.equal((await call('/browser/uploads',{size:16,mediaType})).status,415);
  assert.equal(submitted,before,'Uploading never creates a paid processing job');
});
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
  const beforeForwarded=forwarded,uploadId=await upload();assert.equal(forwarded,beforeForwarded+1);
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

test('artifacts resume with Range from upstream, are copied to R2, then resume from R2 without upstream',async()=>{
  const uploadId=await upload(),id=randomUUID();
  assert.equal((await call('/browser/jobs',{cloudJobId:id,uploadId,mode:'auto',meta:{width:320,height:180,duration:1,fps:24,frames:24}})).status,202);
  await db.prepare('UPDATE jobs SET next_poll_at=0 WHERE id=?').bind(id).run();
  assert.match(await (await call('/browser/jobs/'+id)).text(),/completed/);
  const path='/browser/jobs/'+id+'/artifact';
  const partial=await call(path,undefined,alice,'GET',{Range:'bytes=7-'});
  assert.equal(partial.status,206);assert.equal(partial.headers.get('x-cutout-source'),'upstream');assert.equal(partial.headers.get('content-range'),'bytes 7-11/12');assert.equal(await partial.text(),'video');
  assert.equal((await call(path,undefined,alice,'GET',{Range:'items=0-'})).status,416);
  const full=await call(path);assert.equal(full.status,200);assert.equal(full.headers.get('accept-ranges'),'bytes');assert.equal(await full.text(),'result-video');
  const bucket=await mf.getR2Bucket('STAGING');
  for(let i=0;i<50&&!await bucket.head('results/'+id);i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(await bucket.head('results/'+id),'complete result copied to R2');
  const before=mediaRequests;
  const resumed=await call(path,undefined,alice,'GET',{Range:'bytes=7-'});
  assert.equal(resumed.status,206);assert.equal(resumed.headers.get('x-cutout-source'),'r2');assert.equal(resumed.headers.get('content-range'),'bytes 7-11/12');assert.equal(await resumed.text(),'video');
  assert.equal(await (await call(path)).text(),'result-video');
  const beyond=await call(path,undefined,alice,'GET',{Range:'bytes=12-'});assert.equal(beyond.status,416);assert.equal(beyond.headers.get('content-range'),'bytes */12');
  assert.equal(mediaRequests,before,'cached result never refetches upstream');
  assert.equal((await call(path,undefined,bob,'GET',{Range:'bytes=7-'})).status,404,'cache does not bypass ownership');
});

test('deleting a job removes its result, rows and unused upload; it is owner and device scoped, repeatable and never calls Bria',async()=>{
  const a={'X-Cutout-Device':'dev_'+'e'.repeat(64)},b={'X-Cutout-Device':'dev_'+'f'.repeat(64)};
  const remove=(id:string,token=alice,headers:Record<string,string>=a)=>call('/browser/jobs/'+id,undefined,token,'DELETE',headers);
  const {uploadId}=await (await call('/browser/uploads',{size:16},alice,'POST',a)).json() as {uploadId:string};
  assert.equal((await call(`/browser/uploads/${uploadId}/parts/1`,new Uint8Array(16),alice,'PUT',{...a,'Content-Length':'16'})).status,200);
  assert.equal((await call(`/browser/uploads/${uploadId}/complete`,{},alice,'POST',a)).status,200);
  const id=randomUUID(),start=submitted;
  assert.equal((await call('/browser/jobs',{cloudJobId:id,uploadId,mode:'auto',meta:{width:320,height:180,duration:1,fps:24,frames:24}},alice,'POST',a)).status,202);
  await db.prepare('UPDATE jobs SET next_poll_at=0 WHERE id=?').bind(id).run();
  assert.match(await (await call('/browser/jobs/'+id,undefined,alice,'GET',a)).text(),/completed/);
  assert.equal(await (await call('/browser/jobs/'+id+'/artifact',undefined,alice,'GET',a)).text(),'result-video');
  const bucket=await mf.getR2Bucket('STAGING');
  for(let i=0;i<50&&!await bucket.head('results/'+id);i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(await bucket.head('results/'+id),'result cached before delete');
  const count=async(sql:string,...values:unknown[])=>(await db.prepare(sql).bind(...values).first<{n:number}>())!.n;
  for(const [token,headers] of [[bob,a],[alice,b],[alice,{}]] as const)assert.equal((await remove(id,token,headers)).status,404,'foreign owner or device cannot delete');
  assert.ok(await bucket.head('results/'+id),'denied delete keeps the result');
  assert.equal(await count('SELECT COUNT(*) n FROM jobs WHERE id=?',id),1);
  assert.equal((await remove(id)).status,200);
  assert.equal(await bucket.head('results/'+id),null,'cached result removed');
  assert.equal(await count('SELECT COUNT(*) n FROM jobs WHERE id=?',id),0);
  assert.equal(await count('SELECT COUNT(*) n FROM browser_jobs WHERE id=?',id),0);
  assert.equal(await count('SELECT COUNT(*) n FROM browser_uploads WHERE id=?',uploadId),0,'unused upload record removed');
  assert.equal(await count('SELECT COUNT(*) n FROM browser_parts WHERE upload_id=?',uploadId),0);
  assert.equal(await count('SELECT COUNT(*) n FROM uploads WHERE id=?',uploadId),0);
  assert.equal((await call('/browser/jobs/'+id,undefined,alice,'GET',a)).status,404);
  const again=await remove(id);assert.equal(again.status,404,'repeat delete is a 404');assert.equal((await again.json() as {code:string}).code,'CLOUD_JOB_NOT_FOUND');
  assert.equal(submitted,start+1,'delete never calls Bria');
  // An upload still used by another job survives the first job's removal.
  const shared=await upload(),first=randomUUID(),second=randomUUID(),now=Date.now();
  await call('/browser/jobs',{cloudJobId:first,uploadId:shared,mode:'auto',meta:{width:320,height:180,duration:1,fps:24,frames:24}});
  await db.prepare("INSERT INTO jobs(id,upload_id,fingerprint,params_json,state,created_at,updated_at) VALUES(?,?,?,?,'processing',?,?)").bind(second,shared,'other-fingerprint','{"mode":"auto"}',now,now).run();
  assert.equal((await remove(first,alice,{})).status,200);
  assert.equal(await count('SELECT COUNT(*) n FROM browser_uploads WHERE id=?',shared),1,'shared upload kept');
  assert.equal(await count('SELECT COUNT(*) n FROM jobs WHERE id=?',second),1);
});

test('manual diagnostics are private, device scoped, schema limited and never submit Bria',async()=>{
  const a={'X-Cutout-Device':'dev_'+'a'.repeat(64)},b={'X-Cutout-Device':'dev_'+'b'.repeat(64)};
  const row={time:Date.now(),run:'1234abcd',task:'123456abcdef',event:'sample',lane:0,values:[65536,65536,1200,3]};
  const encode=(r:unknown)=>new TextEncoder().encode(JSON.stringify({schema:1,type:'adplayer-task-diagnostics'})+'\n'+JSON.stringify(r)+'\n');
  const bytes=encode(row),start=submitted;
  const uploadLog=(data:Uint8Array,token=alice,scope=a)=>call('/browser/diagnostics',data,token,'POST',{...scope,'Content-Type':'application/x-ndjson','Content-Length':String(data.length)});
  const response=await uploadLog(bytes);assert.equal(response.status,201,await response.clone().text());
  const receipt=await response.json() as {id:string;bytes:number};assert.match(receipt.id,/^[a-f0-9-]{36}$/);assert.equal(receipt.bytes,bytes.length);
  const path='/browser/diagnostics/'+receipt.id;
  assert.equal(await (await call(path,undefined,alice,'GET',a)).text(),new TextDecoder().decode(bytes));
  assert.equal((await call(path,undefined,alice,'GET',b)).status,404);
  assert.equal((await call(path,undefined,bob,'GET',a)).status,404);
  assert.equal((await call(path)).status,400);
  assert.equal((await uploadLog(bytes,'')).status,401);
  assert.equal((await uploadLog(encode({...row,cookie:'secret'}))).status,400);
  assert.equal((await uploadLog(encode({...row,values:['https://private.invalid/signed']}))).status,400);
  assert.equal((await uploadLog(encode({...row,event:'https://private.invalid'}))).status,400);
  assert.equal((await call('/browser/diagnostics',bytes,alice,'POST',{...a,Origin:'https://evil.example','Content-Type':'application/x-ndjson','Content-Length':String(bytes.length)})).status,403);
  assert.equal((await uploadLog(new Uint8Array(1024*1024+1))).status,413);
  assert.equal(submitted,start,'diagnostic upload never calls Bria');
});
