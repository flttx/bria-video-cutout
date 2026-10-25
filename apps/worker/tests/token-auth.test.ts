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
function call(path:string,body?:unknown,cookie='',extra:Record<string,string>={}) {
  return mf.dispatchFetch('https://app.example'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://app.example','X-Cutout-Client':'1','Content-Type':'application/json',Cookie:cookie,...extra},body:body===undefined?undefined:JSON.stringify(body)});
}
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
