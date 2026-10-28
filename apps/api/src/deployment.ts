import { createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.js";

export interface ServerAccess { origin:string; proxyToken:string; mode?:"proxy"|"basic" }
export function deploymentSettings(env:NodeJS.ProcessEnv) {
  const mode=env.CUTOUT_DEPLOYMENT??"local";
  if(mode!=="local"&&mode!=="standalone")throw new Error("INVALID_DEPLOYMENT");
  const port=Number(env.API_PORT||3001);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error("INVALID_PORT");
  if(mode==="local")return {port,host:"127.0.0.1",access:undefined};
  const accessMode=env.CUTOUT_ACCESS_MODE??"proxy";
  if(accessMode!=="proxy"&&accessMode!=="basic")throw new Error("INVALID_ACCESS_MODE");
  const origin=env.WEB_ORIGIN??"",proxyToken=(accessMode==="basic"?env.CUTOUT_API_PASSWORD:env.CUTOUT_PROXY_TOKEN)??"";
  const url=new URL(origin);
  const loopbackHttp=url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname);
  if((url.protocol!=="https:"&&!loopbackHttp)||url.origin!==origin||proxyToken.length<32)throw new Error("INVALID_SERVER_ACCESS");
  if(env.BRIA_TRANSPORT!=="direct"||!env.BRIA_API_TOKEN?.trim())throw new Error("DIRECT_BRIA_REQUIRED");
  if(!env.DATA_DIR?.trim())throw new Error("DATA_DIR_REQUIRED");
  return {port,host:"0.0.0.0",access:{origin,proxyToken,mode:accessMode}} as const;
}

export function verifyBasicAuth(value:unknown,password:string) {
  const expected="Basic "+Buffer.from(`admin:${password}`).toString("base64");
  const hash=(text:string)=>createHash("sha256").update(text).digest();
  if(typeof value!=="string"||!timingSafeEqual(hash(value),hash(expected))) {
    throw new AppError("AUTH_REQUIRED","请提供有效的接口账号和密码。",401);
  }
}

export function verifyProxyToken(value:unknown,expected:string) {
  const hash=(text:string)=>createHash("sha256").update(text).digest();
  if(typeof value!=="string"||!timingSafeEqual(hash(value),hash(expected))) {
    throw new AppError("AUTH_REQUIRED","请通过已认证的站点入口访问。",401);
  }
}
