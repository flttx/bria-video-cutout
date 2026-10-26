import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {chromium} from 'playwright';
import {existsSync} from 'node:fs';
let mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>;
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'apps/worker/dist/index.js',compatibilityDate:'2026-07-30',d1Databases:['DB'],r2Buckets:['STAGING'],bindings:{AUTH_MODE:'token',BRIA_API_TOKEN:'fake'},outboundService:()=>{throw new Error('No upstream call expected');}}));
  db=await mf.getD1Database('DB');
  for(const file of ['0001_tasks.sql','0002_browser.sql','0003_token_sessions.sql','0004_permanent_tokens.sql','0005_device_scope.sql'])for(const sql of (await readFile('apps/worker/migrations/'+file,'utf8')).split(';').filter(s=>s.trim()))await db.prepare(sql).run();
});
after(async()=>{await mf?.dispose();});
async function grant(owner='alice',expires=Date.now()+60000){
  const token=randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO browser_access_grants(token_hash,owner,expires_at) VALUES(?,?,?)').bind(hash(token),owner,expires).run();return token;
}
function call(path:string,body?:unknown,cookie='',extra:Record<string,string>={},base='https://app.example') {
  return mf.dispatchFetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:base,'X-Cutout-Client':'1','Content-Type':'application/json',Cookie:cookie,...extra},body:body===undefined?undefined:JSON.stringify(body)});
}

const publicOrigin='https://cutout.flttxq.top',workerOrigin='https://cutout-origin.flttxq.top';
function esaCall(path:string,body?:unknown,cookie='',extra:Record<string,string>={}) {
  return call(path,body,cookie,{Origin:publicOrigin,'Sec-Fetch-Site':'same-origin',...extra},workerOrigin);
}

test('ESA permits only the exact origin pair and preserves CSRF checks',async()=>{
  const token=await grant('esa-origins');
  const cases=[
    {name:'third-party origin',headers:{Origin:'https://evil.example'},code:'ORIGIN_REJECTED'},
    {name:'HTTP public origin',headers:{Origin:'http://cutout.flttxq.top'},code:'ORIGIN_REJECTED'},
    {name:'lookalike host',headers:{Origin:publicOrigin+'.evil.example'},code:'ORIGIN_REJECTED'},
    {name:'nonstandard port',headers:{Origin:publicOrigin+':8443'},code:'ORIGIN_REJECTED'},
    {name:'opaque origin',headers:{Origin:'null'},code:'ORIGIN_REJECTED'},
    {name:'missing origin',headers:{Origin:''},code:'CSRF'},
    {name:'missing client marker',headers:{'X-Cutout-Client':''},code:'CSRF'},
    {name:'cross-site metadata',headers:{'Sec-Fetch-Site':'cross-site'},code:'ORIGIN_REJECTED'},
    {name:'forwarded host cannot authorize origin',headers:{Origin:'https://evil.example','X-Forwarded-Host':'cutout.flttxq.top'},code:'ORIGIN_REJECTED'},
  ];
  for(const item of cases) {
    const response=await esaCall('/auth/session',{token},'',item.headers);
    assert.equal(response.status,403,item.name);
    assert.equal((await response.json() as {code:string}).code,item.code,item.name);
  }
  for(const base of ['https://app.example',publicOrigin,'https://cutout-origin.flttxq.top:8443']) {
    const response=await call('/auth/session',{token},'',{Origin:base===publicOrigin?workerOrigin:publicOrigin},base);
    assert.equal(response.status,403,'pair is restricted to the exact destination and direction');
    assert.equal((await response.json() as {code:string}).code,'ORIGIN_REJECTED');
  }
  for(const method of ['POST','PUT','DELETE']) {
    for(const headers of [{Origin:publicOrigin},{'X-Cutout-Client':'1'}]) {
      const response=await mf.dispatchFetch(workerOrigin+'/browser/uploads',{method,headers});
      assert.equal(response.status,403,method+' requires both origin and client marker');
      assert.equal((await response.json() as {code:string}).code,'CSRF');
    }
  }
  const accepted=await esaCall('/auth/session',{token});
  assert.equal(accepted.status,200,'rejected requests did not redeem the grant');
  const cookie=accepted.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await esaCall('/auth/logout',{},cookie)).status,200);
  assert.equal((await call('/auth/session',{token:await grant('direct')},'',{},publicOrigin)).status,200,'original domain still works');
  assert.equal((await mf.dispatchFetch(workerOrigin+'/browser/health')).status,401,'GET without Origin still requires a session');
});

test('ESA login preserves private R2 downloads, Range, owner/device isolation and logout',async()=>{
  const login=await esaCall('/auth/session',{token:await grant('esa-owner')});
  assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie')!,/HttpOnly; Secure; SameSite=Strict/);
  const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const device='dev_'+'a'.repeat(64),otherDevice='dev_'+'b'.repeat(64);
  const health=await esaCall('/browser/health',undefined,cookie,{'X-Cutout-Device':device});
  assert.equal(health.status,200);
  assert.equal((await health.json() as {userId:string}).userId,'esa-owner');

  // Seed a completed private result locally; outbound calls are forbidden by this suite.
  const id=crypto.randomUUID(),uploadId=crypto.randomUUID(),now=Date.now();
  await db.prepare('INSERT INTO uploads(id,file_url,created_at,expires_at) VALUES(?,?,?,?)')
    .bind(uploadId,'https://example.com/input.mp4',now,now+60000).run();
  await db.prepare('INSERT INTO jobs(id,upload_id,fingerprint,params_json,state,status_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(id,uploadId,id,JSON.stringify({mode:'auto'}),'completed',JSON.stringify({result:{video_url:'https://example.com/result.mp4'}}),now,now).run();
  await db.prepare('INSERT INTO browser_jobs(id,owner,device_id) VALUES(?,?,?)').bind(id,'esa-owner',device).run();
  const bucket=await mf.getR2Bucket('STAGING');
  await bucket.put('results/'+id,'result-video');
  const path='/browser/jobs/'+id+'/artifact';
  const full=await esaCall(path,undefined,cookie,{'X-Cutout-Device':device});
  assert.equal(full.status,200);
  assert.equal(full.headers.get('cache-control'),'no-store');
  assert.equal(full.headers.get('content-length'),'12');
  assert.equal(full.headers.get('x-cutout-source'),'r2');
  assert.equal(await full.text(),'result-video');
  const partial=await esaCall(path,undefined,cookie,{'X-Cutout-Device':device,Range:'bytes=7-'});
  assert.equal(partial.status,206);
  assert.equal(partial.headers.get('content-range'),'bytes 7-11/12');
  assert.equal(partial.headers.get('content-length'),'5');
  assert.equal(await partial.text(),'video');

  const otherLogin=await esaCall('/auth/session',{token:await grant('esa-other-owner')});
  assert.equal(otherLogin.status,200);
  const otherCookie=otherLogin.headers.get('set-cookie')!.split(';')[0]!;
  for(const denied of [
    {cookie:'',device,status:401},
    {cookie:otherCookie,device,status:404},
    {cookie,device:otherDevice,status:404},
    {cookie,device:undefined,status:404},
  ]) {
    const response=await esaCall(path,undefined,denied.cookie,{Range:'bytes=7-',...(denied.device?{'X-Cutout-Device':denied.device}:{})});
    assert.equal(response.status,denied.status);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.doesNotMatch(await response.text(),/result-video|example\.com/);
  }
  assert.equal((await esaCall('/auth/logout',{},cookie)).status,200);
  assert.equal((await esaCall(path,undefined,cookie,{'X-Cutout-Device':device})).status,401);
});
test('single-use grant has atomic redemption, secure cookie, identity, revocation and no bearer leakage',async()=>{
  const token=await grant();
  const responses=await Promise.all([call('/auth/session',{token}),call('/auth/session',{token})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,401]);
  const accepted=responses.find(r=>r.status===200)!;
  assert.deepEqual(await accepted.json(),{ok:true});
  const setCookie=accepted.headers.get('set-cookie')!;
  assert.match(setCookie,/__Host-cutout_session=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000/);
  assert.ok(!setCookie.includes(token));
  const cookie=setCookie.split(';')[0]!;
  const row=await db.prepare('SELECT * FROM browser_access_grants WHERE token_hash=?').bind(hash(token)).first();
  assert.ok(!JSON.stringify(row).includes(cookie.split('=')[1]!));
  const health=await call('/browser/health',undefined,cookie);assert.equal(health.status,200);assert.equal((await health.json() as {userId:string}).userId,'alice');
  assert.equal((await call('/auth/session',undefined,cookie)).status,200);
  const out=await call('/auth/logout',{},cookie);assert.equal(out.status,200);assert.match(out.headers.get('set-cookie')!,/Max-Age=0/);
  assert.equal((await call('/browser/health',undefined,cookie)).status,401);
  assert.equal((await call('/auth/session',{token})).status,401);
});
test('expired/invalid links, expired sessions, cross-site writes, oversized bodies and legacy tokens are rejected',async()=>{
  assert.equal((await call('/auth/session',{token:await grant('alice',Date.now()-1)})).status,401);
  assert.equal((await call('/auth/session',{token:randomBytes(32).toString('hex')})).status,401);
  const token=await grant();
  assert.equal((await call('/auth/session',{token},'',{Origin:'https://evil.example'})).status,403);
  assert.equal((await call('/auth/session',{token},'',{'X-Cutout-Client':''})).status,403);
  assert.equal((await call('/auth/session',{token},'',{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await call('/auth/session',{token:'x'.repeat(1024)})).status,413);
  assert.equal((await call('/browser/health',undefined,'',{Authorization:'Bearer '+token,'cf-access-jwt-assertion':token})).status,401);
  const cookie=(await call('/auth/session',{token})).headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await call('/browser/uploads',{size:16},cookie,{Origin:'https://evil.example'})).status,403);
  await db.prepare('UPDATE browser_access_grants SET session_expires_at=0 WHERE token_hash=?').bind(hash(token)).run();
  assert.equal((await call('/browser/health',undefined,cookie)).status,401);
});
test('session owners cannot read another owner job',async()=>{
  const token=await grant('bob'),cookie=(await call('/auth/session',{token})).headers.get('set-cookie')!.split(';')[0]!;
  const id=crypto.randomUUID();await db.prepare('INSERT INTO browser_jobs(id,owner) VALUES(?,?)').bind(id,'alice').run();
  assert.equal((await call('/browser/jobs/'+id,undefined,cookie)).status,404);
});
test('permanent link supports repeat/concurrent login, independent logout, expired-session renewal and full revocation',async()=>{
  const token=await grant('permanent-user',0),grantHash=hash(token);
  await db.prepare('UPDATE browser_access_grants SET permanent=1 WHERE token_hash=?').bind(grantHash).run();
  const responses=await Promise.all([call('/auth/session',{token}),call('/auth/session',{token})]);
  for(const response of responses)assert.equal(response.status,200);
  const cookies=responses.map(r=>r.headers.get('set-cookie')!.split(';')[0]!);
  assert.notEqual(cookies[0],cookies[1]);
  for(const cookie of cookies)assert.equal((await call('/browser/health',undefined,cookie)).status,200);
  await call('/auth/logout',{},cookies[0]);
  assert.equal((await call('/browser/health',undefined,cookies[0])).status,401);
  assert.equal((await call('/browser/health',undefined,cookies[1])).status,200);
  await db.prepare('UPDATE browser_token_sessions SET expires_at=0 WHERE grant_hash=?').bind(grantHash).run();
  assert.equal((await call('/browser/health',undefined,cookies[1])).status,401);
  const renewed=await call('/auth/session',{token});assert.equal(renewed.status,200);
  const freshCookie=renewed.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await call('/browser/health',undefined,freshCookie)).status,200);
  await db.prepare('DELETE FROM browser_access_grants WHERE token_hash=?').bind(grantHash).run();
  assert.equal((await call('/auth/session',{token})).status,401);
  assert.equal((await call('/browser/health',undefined,freshCookie)).status,401);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM browser_token_sessions WHERE grant_hash=?').bind(grantHash).first<{n:number}>())!.n,0);
});
test('real browser clears fragment before exchange, hides HttpOnly cookie and resumes without a link',async()=>{
  const executablePath=process.env.BROWSER_TEST_EXECUTABLE??['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  try {
    const context=await browser.newContext(),page=await context.newPage(),token=await grant('browser');
    let redeemed=0;
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());
      assert.equal(url.origin,'https://app.example');assert.ok(!url.search.includes(token));
      if(url.pathname==='/'){await route.fulfill({status:200,body:'app reached'});return;}
      if(url.pathname==='/auth/session'&&req.method()==='POST'){
        assert.equal(await page.evaluate(()=>location.hash),'');redeemed++;
      }
      const response=await mf.dispatchFetch(req.url(),{method:req.method(),headers:await req.allHeaders(),body:req.postDataBuffer()??undefined});
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers.entries()),body:Buffer.from(await response.arrayBuffer())});
    });
    await page.goto('https://app.example/auth/token#token='+token);await page.waitForURL('https://app.example/');
    assert.equal(redeemed,1);assert.equal(await page.evaluate(()=>document.cookie),'');
    assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
    const cookies=await context.cookies();assert.ok(cookies.some(c=>c.httpOnly&&c.secure&&c.sameSite==='Strict'));
    await page.goto('https://app.example/auth/token');await page.waitForURL('https://app.example/');assert.equal(redeemed,1);
    await page.goto('https://app.example/auth/token#token='+token);await page.waitForURL('https://app.example/');assert.equal(redeemed,2);
    await context.close();
  }finally{await browser.close();}
});
