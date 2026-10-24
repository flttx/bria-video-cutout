import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError } from '../../api/src/errors.js';
import { sameOrigin, sessionIdentity } from './token-auth.js';
export interface AccessEnv { DB:D1Database; AUTH_MODE?:string; ACCESS_TEAM_DOMAIN?:string; ACCESS_AUD?:string; DEV_AUTH?:string }
const keySets=new Map<string,ReturnType<typeof createRemoteJWKSet>>();
export async function browserIdentity(request:Request,env:AccessEnv):Promise<string> {
  const url=new URL(request.url);
  sameOrigin(request);
  if(env.DEV_AUTH==='1'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))return 'local-development';
  if(env.AUTH_MODE==='token')return sessionIdentity(request,env);
  if(env.AUTH_MODE&&env.AUTH_MODE!=='access')throw new AppError('AUTH_CONFIG','身份验证配置无效。',503);
  const domain=env.ACCESS_TEAM_DOMAIN??'';
  if(!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain)||!env.ACCESS_AUD)throw new AppError('ACCESS_CONFIG','请先配置 Cloudflare Access 登录保护。',503);
  const token=request.headers.get('cf-access-jwt-assertion');
  if(!token)throw new AppError('LOGIN_REQUIRED','请通过站点登录入口重新登录。',401);
  try {
    const issuer=`https://${domain}`;
    let keys=keySets.get(issuer);
    if(!keys){keys=createRemoteJWKSet(new URL(issuer+'/cdn-cgi/access/certs'));keySets.set(issuer,keys);}
    const {payload}=await jwtVerify(token,keys,{issuer,audience:env.ACCESS_AUD,algorithms:['RS256']});
    if(!payload.sub||!payload.exp)throw new Error('Invalid identity');
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(issuer+'|'+payload.sub));
    return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  }catch{throw new AppError('LOGIN_REQUIRED','登录已过期或无效，请重新登录。',401);}
}
