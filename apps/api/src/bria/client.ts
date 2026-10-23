import { openAsBlob, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { MaskPoint } from "../config.js";
import type { ColorName } from "../model.js";
import { AppError } from "../errors.js";
import type { PreparedMeta } from "./cloud-contract.js";

import { BriaHttpClient } from "./protocol.js";
import type { BriaSubmitResponse, BriaStatusResponse, UploadGrant } from "./protocol.js";
export { BriaHttpError } from "./protocol.js";
export type { BriaSubmitResponse, BriaStatusResponse } from "./protocol.js";

export interface SubmitContext { cloudJobId:string; meta:PreparedMeta }
export interface BriaGateway {
  readonly kind?:"direct"|"cloud";
  upload(file: string): Promise<string>;
  autoForeground(video: string, color?: ColorName, context?:SubmitContext): Promise<BriaSubmitResponse>;
  maskByPrompt(video: string, prompt: string, context?:SubmitContext): Promise<BriaSubmitResponse>;
  maskByPoints(video: string, frame: number, points: MaskPoint[], context?:SubmitContext): Promise<BriaSubmitResponse>;
  status(id: string): Promise<BriaStatusResponse>;
  download(url: string, file: string): Promise<void>;
}
// Never log upstream bodies, fetch errors or signed URLs.
export async function trustedMediaUrl(value:string):Promise<URL> {
  let url:URL;
  try { url=new URL(value); } catch { throw new AppError("INVALID_UPSTREAM_URL","Bria 返回的文件地址无效。",502); }
  if(url.protocol!=="https:" || url.username || url.password || (url.port && url.port!=="443") || isIP(url.hostname)) throw new AppError("INVALID_UPSTREAM_URL","Bria 返回的文件地址不安全。",502);
  const addresses=await lookup(url.hostname,{all:true});
  if(!addresses.length || addresses.some(({address})=>address.includes(":") ? /^(::|fc|fd|fe80)/i.test(address) : /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address))) throw new AppError("INVALID_UPSTREAM_URL","Bria 文件地址无法安全访问。",502);
  return url;
}
export async function uploadFile(file:string,grant:Pick<UploadGrant,"upload_url"|"upload_fields">,transport:typeof fetch=fetch):Promise<void> {
  const url=await trustedMediaUrl(grant.upload_url);
  const form=new FormData();
  for(const [key,value] of Object.entries(grant.upload_fields)) {
    if(typeof value!=="string") throw new AppError("BRIA_UPLOAD_RESPONSE","Bria 上传字段无效。",502);
    form.append(key,value);
  }
  form.append("file",await openAsBlob(file,{type:"video/mp4"}),"source.mp4");
  try {
    const response=await transport(url,{method:"POST",body:form,redirect:"error",signal:AbortSignal.timeout(600000)});
    if(!response.ok) throw new AppError("BRIA_UPLOAD_FAILED",`Bria 文件上传失败（HTTP ${response.status}）。`,502);
  } catch(e) { if(e instanceof AppError) throw e; throw new AppError("BRIA_UPLOAD_FAILED","Bria 文件上传中断，请稍后恢复。",502); }
}
export async function downloadFile(url:string,file:string,transport:typeof fetch=fetch):Promise<void> {
  const temp=file+".part";
  try {
    let current=url;
    let response:Response|undefined;
    for(let i=0;i<4;i++) {
      response=await transport(await trustedMediaUrl(current),{redirect:"manual",signal:AbortSignal.timeout(600000)});
      if(response.status>=300 && response.status<400 && response.headers.get("location")) { current=new URL(response.headers.get("location")!,current).href; await response.body?.cancel(); continue; }
      break;
    }
    if(response?.status===401||response?.status===403||response?.status===404||response?.status===410)throw new AppError("RESULT_EXPIRED","Bria 结果不可访问或已过期，请核对原任务；不会自动重新抠图。",410);
    if(!response?.ok || !response.body) throw new AppError("RESULT_DOWNLOAD","Bria 结果下载失败，可恢复任务重新获取。",502);
    let size=0;
    const limit=new Transform({transform(chunk:Buffer,_encoding,callback){size+=chunk.length;callback(size>4_000_000_000 ? new AppError("RESULT_TOO_LARGE","结果文件超过本地 4 GB 下载保护上限。",413):null,chunk);}});
    await pipeline(Readable.fromWeb(response.body),limit,createWriteStream(temp,{mode:0o600}));
    await rename(temp,file);
  } catch(e) { await rm(temp,{force:true}); if(e instanceof AppError) throw e; throw new AppError("RESULT_DOWNLOAD","Bria 结果下载中断，可恢复任务重新获取。",502); }
}
export class BriaClient extends BriaHttpClient implements BriaGateway {
  constructor(token:string,private readonly mediaTransport:typeof fetch=fetch) {super(token,mediaTransport);}
  async upload(file:string):Promise<string> {
    const grant=await this.uploadGrant();
    await trustedMediaUrl(grant.file_url);
    await uploadFile(file,grant,this.mediaTransport);
    return grant.file_url;
  }
  download(url:string,file:string) {return downloadFile(url,file,this.mediaTransport);}
}
