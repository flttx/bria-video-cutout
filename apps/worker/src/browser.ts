import { AppError, object } from '../../api/src/errors.js';
import { validId, MAX_BYTES } from '../../api/src/model.js';
import { BriaHttpClient, mediaUrl } from '../../api/src/bria/protocol.js';
import type { BriaStatusResponse } from '../../api/src/bria/protocol.js';
import { parseCloudInput } from '../../api/src/bria/cloud-contract.js';
import { body, submit, status } from './legacy.js';
import type { Env } from './legacy.js';
import { browserIdentity } from './access.js';
import type { AccessEnv } from './access.js';
import { diagnostics } from './diagnostics.js';
export interface BrowserEnv extends Env,AccessEnv { STAGING:R2Bucket; ASSETS:Fetcher; BRIA_MEDIA_HOSTS?:string }
const CHUNK=8*1024*1024;
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
interface Upload { id:string; owner:string; device_id:string; size:number; multipart_id:string; state:string; expires_at:number }
function upstreamUrl(value:string,env:BrowserEnv) {
  const url=mediaUrl(value);
  const roots=['amazonaws.com','cloudfront.net','bria.ai','bria-api.com',...(env.BRIA_MEDIA_HOSTS??'').split(',').map(s=>s.trim()).filter(Boolean)];
  if(!roots.some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))throw new AppError('MEDIA_HOST','上游媒体域名尚未获准，请联系管理员核对配置。',502);
  return url.href;
}
async function ownedUpload(id:string,owner:string,device:string,env:BrowserEnv) {
  const row=await env.DB.prepare('SELECT * FROM browser_uploads WHERE id=? AND owner=? AND device_id=?').bind(id,owner,device).first<Upload>();
  if(!row)throw new AppError('NOT_FOUND','上传记录不存在。',404);
  if(row.expires_at<=Date.now())throw new AppError('UPLOAD_EXPIRED','上传已过期，请重新上传。',410);
  return row;
}
async function ownedJob(id:string,owner:string,device:string,env:BrowserEnv) {
  if(!await env.DB.prepare('SELECT id FROM browser_jobs WHERE id=? AND owner=? AND device_id=?').bind(id,owner,device).first())throw new AppError('NOT_FOUND','任务不存在。',404);
}
async function publicJob(response:Response) {
  const data=await response.json() as {id:string;state:string;httpStatus?:number;status?:BriaStatusResponse};
  return json({id:data.id,state:data.state,httpStatus:data.httpStatus,warning:!!data.status?.result?.warning,resultAvailable:!!(data.status?.result?.mask_url||data.status?.result?.video_url)},response.status);
}
// Engineering decision: results are copied to R2 under results/<job id> so repeat and resumed downloads are served
// from Cloudflare instead of re-fetching the upstream media URL. Only the response headers are time-limited; a slow
// body transfer is never cut off mid-stream, and clients resume with "Range: bytes=N-".
const RESULT_HEADERS_TIMEOUT=30_000;
function artifactHeaders(extra:Record<string,string>) {
  return new Headers({'Content-Type':'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes',...extra});
}
function rangeStart(request:Request) {
  const header=request.headers.get('range');if(header===null)return null;
  const match=/^bytes=(\d+)-$/.exec(header.trim());if(!match)throw new AppError('RANGE_INVALID','仅支持从指定字节继续下载。',416);
  return Number(match[1]);
}
async function artifact(request:Request,id:string,url:string,env:BrowserEnv,ctx?:ExecutionContext) {
  const start=rangeStart(request),key='results/'+id,cached=await env.STAGING.head(key);
  if(cached) {
    if(start!==null&&start>=cached.size)return new Response(null,{status:416,headers:artifactHeaders({'Content-Range':`bytes */${cached.size}`})});
    const object=await env.STAGING.get(key,start?{range:{offset:start}}:undefined);
    if(!object)throw new AppError('RESULT_MISSING','处理结果缺少媒体文件。',502);
    const from=start??0,length=cached.size-from;
    return new Response(object.body,{status:start?206:200,headers:artifactHeaders({'X-Cutout-Source':'r2','Content-Length':String(length),...(start?{'Content-Range':`bytes ${from}-${cached.size-1}/${cached.size}`}:{})})});
  }
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),RESULT_HEADERS_TIMEOUT);
  let response:Response;
  try{response=await fetch(upstreamUrl(url,env),{redirect:'manual',signal:controller.signal,headers:start?{Range:`bytes=${start}-`}:{}});}
  catch(error){if(error instanceof AppError)throw error;throw new AppError('RESULT_TIMEOUT','结果服务器暂时没有响应，请稍后重试；不会重新抠图。',504);}
  finally{clearTimeout(timer);}
  if(response.status===416){await response.body?.cancel();return new Response(null,{status:416,headers:artifactHeaders({})});}
  if(!response.ok||!response.body){await response.body?.cancel();throw new AppError('RESULT_EXPIRED','结果不可下载或已过期，不会自动重新抠图。',410);}
  const extra:Record<string,string>={'X-Cutout-Source':'upstream'},length=response.headers.get('content-length');if(length)extra['Content-Length']=length;
  const partial=response.status===206,contentRange=response.headers.get('content-range');
  if(partial&&contentRange)extra['Content-Range']=contentRange;
  let body:ReadableStream=response.body;
  // A complete upstream body is also copied to R2 in the background; a failed copy only means the next request
  // fetches upstream again.
  if(!partial&&length&&ctx) {
    const [client,copy]=response.body.tee(),fixed=new FixedLengthStream(Number(length));body=client;
    ctx.waitUntil(Promise.all([copy.pipeTo(fixed.writable),env.STAGING.put(key,fixed.readable,{httpMetadata:{contentType:'video/mp4'}})]).catch(()=>{}));
  }
  return new Response(body,{status:partial?206:200,headers:artifactHeaders(extra)});
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
// Removes one owned job and everything stored for it: the cached result in R2, the job rows and, when no other job
// uses the same upload, the upload record and any leftover staging object. Bria exposes no cancel call, so an
// unfinished upstream request simply stops being tracked. Calling it again for a gone job answers 404.
async function removeJob(id:string,owner:string,device:string,env:BrowserEnv) {
  // A distinct code lets clients tell "job already gone" from an unknown route on a server without this endpoint.
  if(!await env.DB.prepare('SELECT id FROM browser_jobs WHERE id=? AND owner=? AND device_id=?').bind(id,owner,device).first())throw new AppError('CLOUD_JOB_NOT_FOUND','云端任务不存在或已删除。',404);
  const row=await env.DB.prepare('SELECT upload_id FROM jobs WHERE id=?').bind(id).first<{upload_id:string}>();
  const uploadId=row?.upload_id;
  await env.STAGING.delete('results/'+id);
  const statements=[env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(id),env.DB.prepare('DELETE FROM browser_jobs WHERE id=? AND owner=? AND device_id=?').bind(id,owner,device)];
  if(uploadId) {
    const unused='NOT EXISTS(SELECT 1 FROM jobs WHERE upload_id=?)';
    statements.push(
      env.DB.prepare(`DELETE FROM browser_parts WHERE upload_id IN(SELECT id FROM browser_uploads WHERE id=? AND owner=? AND device_id=?) AND ${unused}`).bind(uploadId,owner,device,uploadId),
      env.DB.prepare(`DELETE FROM browser_uploads WHERE id=? AND owner=? AND device_id=? AND ${unused}`).bind(uploadId,owner,device,uploadId),
      env.DB.prepare(`DELETE FROM uploads WHERE id=? AND ${unused}`).bind(uploadId,uploadId));
  }
  await env.DB.batch(statements);
  if(uploadId&&!await env.DB.prepare('SELECT id FROM jobs WHERE upload_id=?').bind(uploadId).first())await env.STAGING.delete('uploads/'+uploadId);
  return json({ok:true});
}
export async function browserFetch(request:Request,env:BrowserEnv,ctx?:ExecutionContext):Promise<Response> {
  try {
    const owner=await browserIdentity(request,env),path=new URL(request.url).pathname;
    const header=request.headers.get('x-cutout-device');
    if(header!==null&&!/^dev_[a-f0-9]{64}$/.test(header))throw new AppError('DEVICE_INVALID','设备标识无效。',400);
    const device=header??''; // Unupgraded web clients retain a separate legacy namespace.
    if(path==='/browser/health'&&request.method==='GET') {
      await env.DB.prepare('SELECT id,device_id FROM browser_jobs LIMIT 1').first();await env.DB.prepare('SELECT id FROM jobs LIMIT 1').first();
      return json({ok:true,userId:owner,deviceIsolation:true,deviceId:device,tokenConfigured:!!env.BRIA_API_TOKEN,processingReady:!!env.BRIA_API_TOKEN&&!!env.STAGING});
    }
    if(path==='/browser/diagnostics'||path.startsWith('/browser/diagnostics/')){
      if(!env.STAGING)throw new AppError('CLOUD_CONFIG','日志存储暂不可用。',503);
      return await diagnostics(request,owner,device,env.STAGING);
    }
    if(!env.BRIA_API_TOKEN||!env.STAGING)throw new AppError('CLOUD_CONFIG','请配置 Bria Secret 和临时上传存储。',503);
    const bria=new BriaHttpClient(env.BRIA_API_TOKEN);
    if(path==='/browser/uploads'&&request.method==='POST') {
      const input=object(await body(request));
      if(!Number.isInteger(input.size)||Number(input.size)<1||Number(input.size)>MAX_BYTES)throw new AppError('UPLOAD_SIZE','视频须大于 0 字节且不超过 1 GB。',413);
      const id=crypto.randomUUID(),now=Date.now(),upload=await env.STAGING.createMultipartUpload('uploads/'+id,{httpMetadata:{contentType:'video/mp4'}});
      try{await env.DB.prepare('INSERT INTO browser_uploads(id,owner,size,multipart_id,created_at,expires_at,device_id) VALUES(?,?,?,?,?,?,?)').bind(id,owner,input.size,upload.uploadId,now,now+86400000,device).run();}catch(error){await upload.abort();throw error;}
      return json({uploadId:id,chunkSize:CHUNK},201);
    }
    const part=path.match(/^\/browser\/uploads\/([^/]+)\/parts\/(\d+)$/);
    if(part&&request.method==='PUT') {
      const row=await ownedUpload(validId(part[1]),owner,device,env),number=Number(part[2]);
      if(row.state!=='uploading')throw new AppError('UPLOAD_LOCKED','上传已结束，请重新创建上传。',409);
      const expected=Math.min(CHUNK,row.size-(number-1)*CHUNK);
      if(number<1||number>Math.ceil(row.size/CHUNK)||Number(request.headers.get('content-length'))!==expected||!request.body)throw new AppError('UPLOAD_PART','分片大小或编号不正确。',400);
      const result=await env.STAGING.resumeMultipartUpload('uploads/'+row.id,row.multipart_id).uploadPart(number,request.body);
      await env.DB.prepare('INSERT INTO browser_parts(upload_id,part_number,etag) VALUES(?,?,?) ON CONFLICT(upload_id,part_number) DO UPDATE SET etag=excluded.etag').bind(row.id,number,result.etag).run();
      return json({ok:true});
    }
    const finish=path.match(/^\/browser\/uploads\/([^/]+)\/complete$/);
    if(finish&&request.method==='POST') {
      const row=await ownedUpload(validId(finish[1]),owner,device,env);if(row.state==='complete')return json({uploadId:row.id});
      const parts=await env.DB.prepare('SELECT part_number,etag FROM browser_parts WHERE upload_id=? ORDER BY part_number').bind(row.id).all<{part_number:number;etag:string}>();
      if(parts.results.length!==Math.ceil(row.size/CHUNK)||parts.results.some((part,index)=>part.part_number!==index+1))throw new AppError('UPLOAD_INCOMPLETE','请完成所有分片后再提交。',409);
      const locked=await env.DB.prepare("UPDATE browser_uploads SET state='forwarding' WHERE id=? AND state='uploading'").bind(row.id).run();
      if(!locked.meta.changes)throw new AppError('UPLOAD_UNCERTAIN','上传转交尚未确认，请重新上传；尚未提交抠图。',409);
      await env.STAGING.resumeMultipartUpload('uploads/'+row.id,row.multipart_id).complete(parts.results.map(p=>({partNumber:p.part_number,etag:p.etag})));
      await forwardUpload(row,env,bria);return json({uploadId:row.id});
    }
    if(path==='/browser/jobs'&&request.method==='POST') {
      const input=parseCloudInput(await body(request)),upload=await ownedUpload(input.uploadId,owner,device,env);
      if(upload.state!=='complete')throw new AppError('UPLOAD_INCOMPLETE','视频尚未上传完成。',409);
      await env.DB.prepare('INSERT INTO browser_jobs(id,owner,device_id) SELECT ?,?,? WHERE NOT EXISTS(SELECT id FROM jobs WHERE id=?) ON CONFLICT(id) DO NOTHING').bind(input.cloudJobId,owner,device,input.cloudJobId).run();
      await ownedJob(input.cloudJobId,owner,device,env);
      return publicJob(await submit(new Request(request.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),env,bria));
    }
    // Explicit, idempotent upgrade of locally known legacy jobs; never calls Bria.
    const claim=path.match(/^\/browser\/jobs\/([^/]+)\/claim-device$/);
    if(claim&&request.method==='POST') {
      if(!device)throw new AppError('DEVICE_REQUIRED','请提供设备标识。',400);
      const id=validId(claim[1]);
      await env.DB.prepare("UPDATE browser_jobs SET device_id=? WHERE id=? AND owner=? AND device_id=''").bind(device,id,owner).run();
      await ownedJob(id,owner,device,env);
      return json({ok:true});
    }
    const job=path.match(/^\/browser\/jobs\/([^/]+)(\/artifact)?$/);
    if(job&&!job[2]&&request.method==='DELETE') return await removeJob(validId(job[1]),owner,device,env);
    if(job&&request.method==='GET') {
      const id=validId(job[1]);await ownedJob(id,owner,device,env);
      if(!job[2])return publicJob(await status(id,env,bria));
      const row=await env.DB.prepare('SELECT state,status_json,params_json FROM jobs WHERE id=?').bind(id).first<{state:string;status_json:string;params_json:string}>();
      if(row?.state!=='completed')throw new AppError('NOT_READY','结果尚未完成。',409);
      const result=(JSON.parse(row.status_json) as BriaStatusResponse).result,params=JSON.parse(row.params_json) as {mode:string};
      const url=params.mode==='auto'?result?.video_url:result?.mask_url??result?.video_url;
      if(!url)throw new AppError('RESULT_MISSING','处理结果缺少媒体文件。',502);
      return await artifact(request,id,url,env,ctx);
    }
    throw new AppError('NOT_FOUND','接口不存在。',404);
  }catch(error){return error instanceof AppError?json({code:error.code,message:error.message},error.statusCode):json({code:'CLOUD_STORAGE',message:'云端服务暂不可用，请稍后查询原任务。'},503);}
}
