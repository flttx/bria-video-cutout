import { AppError } from '../../api/src/errors.js';

export interface TokenEnv { DB:D1Database; AUTH_MODE?:string }
const COOKIE='__Host-cutout_session';
const SESSION_SECONDS=30*86400;
const validToken=(value:string)=>/^[a-f0-9]{64}$/.test(value);
export async function digest(value:string):Promise<string> {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
function randomToken():string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
}
function cookie(request:Request):string {
  const values=(request.headers.get('cookie')??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(COOKIE+'='));
  if(values.length!==1)return '';
  const value=values[0]!.slice(COOKIE.length+1);
  return validToken(value)?value:'';
}
export function sameOrigin(request:Request):void {
  const origin=request.headers.get('origin'),url=new URL(request.url);
  // ESA preserves the public Origin while forwarding to the dedicated Worker host.
  const allowedOrigin=origin===url.origin||(
    url.origin==='https://cutout-origin.flttxq.top'&&origin==='https://cutout.flttxq.top'
  );
  if(origin&&!allowedOrigin)throw new AppError('ORIGIN_REJECTED','不允许跨站访问。',403);
  if(request.headers.get('sec-fetch-site')==='cross-site')throw new AppError('ORIGIN_REJECTED','不允许跨站访问。',403);
  if(request.method!=='GET'&&(!origin||request.headers.get('x-cutout-client')!=='1'))throw new AppError('CSRF','请求缺少同源验证。',403);
}
export async function sessionIdentity(request:Request,env:TokenEnv):Promise<string> {
  const value=cookie(request);
  if(value&&new URL(request.url).protocol==='https:') {
    const hash=await digest(value),now=Date.now();
    const row=await env.DB.prepare('SELECT owner FROM browser_access_grants WHERE session_hash=? AND session_expires_at>? UNION ALL SELECT g.owner FROM browser_token_sessions s JOIN browser_access_grants g ON g.token_hash=s.grant_hash WHERE s.session_hash=? AND s.expires_at>? AND g.permanent=1 LIMIT 1')
      .bind(hash,now,hash,now).first<{owner:string}>();
    if(row)return row.owner;
  }
  throw new AppError('LOGIN_REQUIRED','请重新打开访问链接；永久链接可重复使用。',401);
}
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
function landing():Response {
  const nonce=randomToken();
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>进入视频抠图</title><body><p id="status">正在验证访问链接…</p><script nonce="${nonce}">
(async()=>{
  let token=new URLSearchParams(location.hash.slice(1)).get('token')||'';
  history.replaceState(null,'',location.pathname);
  const status=document.getElementById('status');
  try {
    const options=token?{method:'POST',headers:{'Content-Type':'application/json','X-Cutout-Client':'1'},body:JSON.stringify({token})}:{method:'GET'};
    token='';
    let response=await fetch('/auth/session',{...options,credentials:'same-origin',cache:'no-store',redirect:'error'});
    if(response.status===401&&options.method==='POST')response=await fetch('/auth/session',{credentials:'same-origin',cache:'no-store',redirect:'error'});
    if(response.ok){location.replace('/');return;}
    status.textContent='访问链接无效或已撤销；一次性链接也可能已使用或已过期。';
  }catch{status.textContent='连接中断，请重新打开原访问链接；若提示已使用，请生成新链接。';}
})();
</script></body></html>`,{headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`}});
}
async function readToken(request:Request):Promise<string> {
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new AppError('TOKEN_INVALID','访问链接无效。',400);
  const reader=request.body?.getReader();
  if(!reader)throw new AppError('TOKEN_INVALID','访问链接无效。',400);
  let text='',size=0;const decoder=new TextDecoder();
  try {
    while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>256){await reader.cancel();throw new AppError('TOKEN_INVALID','访问链接无效。',413);}text+=decoder.decode(chunk.value,{stream:true});}
    text+=decoder.decode();
  }finally{reader.releaseLock();}
  let input:unknown;try{input=JSON.parse(text);}catch{throw new AppError('TOKEN_INVALID','访问链接无效。',400);}
  const token=(input as {token?:unknown}|null)?.token;
  if(typeof token!=='string'||!validToken(token))throw new AppError('TOKEN_INVALID','访问链接无效。',401);
  return token;
}
export async function tokenAuth(request:Request,env:TokenEnv):Promise<Response> {
  try {
    if(env.AUTH_MODE!=='token')return new Response('Not found',{status:404,headers});
    const url=new URL(request.url);
    if(url.protocol!=='https:')throw new AppError('HTTPS_REQUIRED','访问链接必须使用 HTTPS。',400);
    if(url.pathname==='/auth/token'&&request.method==='GET')return landing();
    sameOrigin(request);
    if(url.pathname==='/auth/session'&&request.method==='GET') {
      await sessionIdentity(request,env);return Response.json({ok:true},{headers});
    }
    if(url.pathname==='/auth/session'&&request.method==='POST') {
      const token=await readToken(request),session=randomToken(),now=Date.now();
      const sessionHash=await digest(session),grantHash=await digest(token),expires=now+SESSION_SECONDS*1000;
      // Each reusable-token login creates an independent session. Revoking its parent invalidates all of them.
      let row=await env.DB.prepare('INSERT INTO browser_token_sessions(session_hash,grant_hash,expires_at) SELECT ?,token_hash,? FROM browser_access_grants WHERE token_hash=? AND permanent=1 RETURNING session_hash')
        .bind(sessionHash,expires,grantHash).first();
      // Preserve atomic single-use redemption for previously issued links.
      if(!row)row=await env.DB.prepare('UPDATE browser_access_grants SET session_hash=?,session_expires_at=? WHERE token_hash=? AND permanent=0 AND session_hash IS NULL AND expires_at>? RETURNING owner')
        .bind(sessionHash,expires,grantHash,now).first();
      if(!row)throw new AppError('TOKEN_INVALID','访问链接无效、已使用或已过期。',401);
      return Response.json({ok:true},{headers:{...headers,'Set-Cookie':`${COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`}});
    }
    if(url.pathname==='/auth/logout'&&request.method==='POST') {
      const value=cookie(request);
      if(value){const hash=await digest(value);await env.DB.batch([
        env.DB.prepare('DELETE FROM browser_access_grants WHERE session_hash=? AND permanent=0').bind(hash),
        env.DB.prepare('DELETE FROM browser_token_sessions WHERE session_hash=?').bind(hash)
      ]);}
      return Response.json({ok:true},{headers:{...headers,'Set-Cookie':`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`}});
    }
    return new Response('Not found',{status:404,headers});
  }catch(error){
    if(error instanceof AppError)return Response.json({code:error.code,message:error.message},{status:error.statusCode,headers});
    return Response.json({code:'AUTH_UNAVAILABLE',message:'访问验证暂不可用，请稍后重试。'},{status:503,headers});
  }
}
