import { AppError, object } from '../../api/src/errors.js';
import { validId, MAX_BYTES } from '../../api/src/model.js';
import { BriaHttpClient, mediaUrl } from '../../api/src/bria/protocol.js';
import type { BriaStatusResponse } from '../../api/src/bria/protocol.js';
import { parseCloudInput } from '../../api/src/bria/cloud-contract.js';
import { body, submit, status } from './legacy.js';
import type { Env } from './legacy.js';
import { browserIdentity } from './access.js';
import type { AccessEnv } from './access.js';
export interface BrowserEnv extends Env,AccessEnv { STAGING:R2Bucket; ASSETS:Fetcher; BRIA_MEDIA_HOSTS?:string }
const CHUNK=8*1024*1024;
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
interface Upload { id:string; owner:string; size:number; multipart_id:string; state:string; expires_at:number }
function upstreamUrl(value:string,env:BrowserEnv) {
  const url=mediaUrl(value);
  const roots=['amazonaws.com','cloudfront.net','bria.ai','bria-api.com',...(env.BRIA_MEDIA_HOSTS??'').split(',').map(s=>s.trim()).filter(Boolean)];
  if(!roots.some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))throw new AppError('MEDIA_HOST','上游媒体域名尚未获准，请联系管理员核对配置。',502);
  return url.href;
}
async function ownedUpload(id:string,owner:string,env:BrowserEnv) {
  const row=await env.DB.prepare('SELECT * FROM browser_uploads WHERE id=? AND owner=?').bind(id,owner).first<Upload>();
  if(!row)throw new AppError('NOT_FOUND','上传记录不存在。',404);
  if(row.expires_at<=Date.now())throw new AppError('UPLOAD_EXPIRED','上传已过期，请重新上传。',410);
  return row;
}
async function ownedJob(id:string,owner:string,env:BrowserEnv) {
  if(!await env.DB.prepare('SELECT id FROM browser_jobs WHERE id=? AND owner=?').bind(id,owner).first())throw new AppError('NOT_FOUND','任务不存在。',404);
}
async function publicJob(response:Response) {
  const data=await response.json() as {id:string;state:string;httpStatus?:number;status?:BriaStatusResponse};
  return json({id:data.id,state:data.state,httpStatus:data.httpStatus,warning:!!data.status?.result?.warning,resultAvailable:!!(data.status?.result?.mask_url||data.status?.result?.video_url)},response.status);
}
async function forwardUpload(row:Upload,env:BrowserEnv,bria:BriaHttpClient) {
  const stored=await env.STAGING.get('uploads/'+row.id);
  if(!stored||stored.size!==row.size)throw new AppError('UPLOAD_INCOMPLETE','上传文件尚不完整。',409);
  const grant=await bria.uploadGrant(),boundary='cutout-'+crypto.randomUUID();
  const encoder=new TextEncoder();let fields='';
  for(const [key,value] of Object.entries(grant.upload_fields)) {
    if(!/^[a-zA-Z0-9_-]+$/.test(key))throw new AppError('BRIA_UPLOAD_RESPONSE','上游上传字段无效。',502);
    fields+=`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
  }
  const prefix=encoder.encode(fields+`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
  const suffix=encoder.encode(`\r\n--${boundary}--\r\n`);
  const stream=new FixedLengthStream(prefix.byteLength+stored.size+suffix.byteLength),writer=stream.writable.getWriter();
  const pumping=(async()=>{try{await writer.write(prefix);const reader=stored.body.getReader();try{while(true){const part=await reader.read();if(part.done)break;await writer.write(part.value);}}finally{reader.releaseLock();}await writer.write(suffix);await writer.close();}catch(error){await writer.abort(error).catch(()=>{});throw error;}})();
  pumping.catch(()=>{});
  try {
    const response=await fetch(upstreamUrl(grant.upload_url,env),{method:'POST',headers:{'Content-Type':`multipart/form-data; boundary=${boundary}`},body:stream.readable,redirect:'manual',signal:AbortSignal.timeout(180000)});
    if(!response.ok){await writer.abort().catch(()=>{});throw new AppError('BRIA_UPLOAD_FAILED','视频转交 Bria 失败，请重新上传。',502);}
    await pumping;await response.body?.cancel();
  }catch(error){await writer.abort().catch(()=>{});if(error instanceof AppError)throw error;throw new AppError('BRIA_UPLOAD_FAILED','视频上传超时或中断，请重新上传。',502);}
  const now=Date.now();
  await env.DB.batch([env.DB.prepare('INSERT INTO uploads(id,file_url,created_at,expires_at) VALUES(?,?,?,?)').bind(row.id,grant.file_url,now,now+86400000),env.DB.prepare("UPDATE browser_uploads SET state='complete' WHERE id=?").bind(row.id)]);
  await env.STAGING.delete('uploads/'+row.id);
}
export async function browserFetch(request:Request,env:BrowserEnv):Promise<Response> {
  try {
    const owner=await browserIdentity(request,env),path=new URL(request.url).pathname;
    if(path==='/browser/health'&&request.method==='GET') {
      await env.DB.prepare('SELECT id FROM browser_jobs LIMIT 1').first();await env.DB.prepare('SELECT id FROM jobs LIMIT 1').first();
      return json({ok:true,userId:owner,tokenConfigured:!!env.BRIA_API_TOKEN,processingReady:!!env.BRIA_API_TOKEN&&!!env.STAGING});
    }
    if(!env.BRIA_API_TOKEN||!env.STAGING)throw new AppError('CLOUD_CONFIG','请配置 Bria Secret 和临时上传存储。',503);
    const bria=new BriaHttpClient(env.BRIA_API_TOKEN);
    if(path==='/browser/uploads'&&request.method==='POST') {
      const input=object(await body(request));
      if(!Number.isInteger(input.size)||Number(input.size)<1||Number(input.size)>MAX_BYTES)throw new AppError('UPLOAD_SIZE','视频须大于 0 字节且不超过 1 GB。',413);
      const id=crypto.randomUUID(),now=Date.now(),upload=await env.STAGING.createMultipartUpload('uploads/'+id,{httpMetadata:{contentType:'video/mp4'}});
      try{await env.DB.prepare('INSERT INTO browser_uploads(id,owner,size,multipart_id,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(id,owner,input.size,upload.uploadId,now,now+86400000).run();}catch(error){await upload.abort();throw error;}
      return json({uploadId:id,chunkSize:CHUNK},201);
    }
    const part=path.match(/^\/browser\/uploads\/([^/]+)\/parts\/(\d+)$/);
    if(part&&request.method==='PUT') {
      const row=await ownedUpload(validId(part[1]),owner,env),number=Number(part[2]);
      if(row.state!=='uploading')throw new AppError('UPLOAD_LOCKED','上传已结束，请重新创建上传。',409);
      const expected=Math.min(CHUNK,row.size-(number-1)*CHUNK);
      if(number<1||number>Math.ceil(row.size/CHUNK)||Number(request.headers.get('content-length'))!==expected||!request.body)throw new AppError('UPLOAD_PART','分片大小或编号不正确。',400);
      const result=await env.STAGING.resumeMultipartUpload('uploads/'+row.id,row.multipart_id).uploadPart(number,request.body);
      await env.DB.prepare('INSERT INTO browser_parts(upload_id,part_number,etag) VALUES(?,?,?) ON CONFLICT(upload_id,part_number) DO UPDATE SET etag=excluded.etag').bind(row.id,number,result.etag).run();
      return json({ok:true});
    }
    const finish=path.match(/^\/browser\/uploads\/([^/]+)\/complete$/);
    if(finish&&request.method==='POST') {
      const row=await ownedUpload(validId(finish[1]),owner,env);if(row.state==='complete')return json({uploadId:row.id});
      const parts=await env.DB.prepare('SELECT part_number,etag FROM browser_parts WHERE upload_id=? ORDER BY part_number').bind(row.id).all<{part_number:number;etag:string}>();
      if(parts.results.length!==Math.ceil(row.size/CHUNK)||parts.results.some((part,index)=>part.part_number!==index+1))throw new AppError('UPLOAD_INCOMPLETE','请完成所有分片后再提交。',409);
      const locked=await env.DB.prepare("UPDATE browser_uploads SET state='forwarding' WHERE id=? AND state='uploading'").bind(row.id).run();
      if(!locked.meta.changes)throw new AppError('UPLOAD_UNCERTAIN','上传转交尚未确认，请重新上传；尚未提交抠图。',409);
      await env.STAGING.resumeMultipartUpload('uploads/'+row.id,row.multipart_id).complete(parts.results.map(p=>({partNumber:p.part_number,etag:p.etag})));
      await forwardUpload(row,env,bria);return json({uploadId:row.id});
    }
    if(path==='/browser/jobs'&&request.method==='POST') {
      const input=parseCloudInput(await body(request)),upload=await ownedUpload(input.uploadId,owner,env);
      if(upload.state!=='complete')throw new AppError('UPLOAD_INCOMPLETE','视频尚未上传完成。',409);
      await env.DB.prepare('INSERT INTO browser_jobs(id,owner) SELECT ?,? WHERE NOT EXISTS(SELECT id FROM jobs WHERE id=?) ON CONFLICT(id) DO NOTHING').bind(input.cloudJobId,owner,input.cloudJobId).run();
      await ownedJob(input.cloudJobId,owner,env);
      return publicJob(await submit(new Request(request.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),env,bria));
    }
    const job=path.match(/^\/browser\/jobs\/([^/]+)(\/artifact)?$/);
    if(job&&request.method==='GET') {
      const id=validId(job[1]);await ownedJob(id,owner,env);
      if(!job[2])return publicJob(await status(id,env,bria));
      const row=await env.DB.prepare('SELECT state,status_json,params_json FROM jobs WHERE id=?').bind(id).first<{state:string;status_json:string;params_json:string}>();
      if(row?.state!=='completed')throw new AppError('NOT_READY','结果尚未完成。',409);
      const result=(JSON.parse(row.status_json) as BriaStatusResponse).result,params=JSON.parse(row.params_json) as {mode:string};
      const url=params.mode==='auto'?result?.video_url:result?.mask_url??result?.video_url;
      if(!url)throw new AppError('RESULT_MISSING','处理结果缺少媒体文件。',502);
      const response=await fetch(upstreamUrl(url,env),{redirect:'manual',signal:AbortSignal.timeout(180000)});
      if(!response.ok){await response.body?.cancel();throw new AppError('RESULT_EXPIRED','结果不可下载或已过期，不会自动重新抠图。',410);}
      const headers=new Headers({'Content-Type':'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      const length=response.headers.get('content-length');if(length)headers.set('Content-Length',length);
      return new Response(response.body,{headers});
    }
    throw new AppError('NOT_FOUND','接口不存在。',404);
  }catch(error){return error instanceof AppError?json({code:error.code,message:error.message},error.statusCode):json({code:'CLOUD_STORAGE',message:'云端服务暂不可用，请稍后查询原任务。'},503);}
}
