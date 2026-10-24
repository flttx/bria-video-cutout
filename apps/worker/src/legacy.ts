import { AppError, object } from "../../api/src/errors.js";
import { validId } from "../../api/src/model.js";
import { BriaHttpClient, BriaHttpError } from "../../api/src/bria/protocol.js";
import type { BriaStatusResponse } from "../../api/src/bria/protocol.js";
import { parseCloudInput } from "../../api/src/bria/cloud-contract.js";
import type { CloudJobView } from "../../api/src/bria/cloud-contract.js";

export interface Env { DB:D1Database; BRIA_API_TOKEN:string; CUTOUT_CLOUD_TOKEN:string }
interface JobRow {
  id:string; upload_id:string; fingerprint:string; state:CloudJobView["state"];
  request_id:string|null; status_json:string|null; http_status:number|null;
  created_at:number; updated_at:number; next_poll_at:number; poll_failures:number;
}
const SUBMIT_TIMEOUT=90_000,POLL_INTERVAL=5_000;
function json(value:unknown,status=200) {
  return Response.json(value,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
async function digest(value:string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));
}
async function authenticate(request:Request,env:Env) {
  if(!env.CUTOUT_CLOUD_TOKEN||env.CUTOUT_CLOUD_TOKEN.length<32)throw new AppError("CLOUD_CONFIG","云端鉴权尚未配置。",503);
  const header=request.headers.get("authorization")??"";
  if(header.length>512)throw new AppError("UNAUTHORIZED","云端访问凭据无效。",401);
  const supplied=await digest(header),expected=await digest(`Bearer ${env.CUTOUT_CLOUD_TOKEN}`);
  let diff=0;for(let i=0;i<expected.length;i++)diff|=expected[i]!^supplied[i]!;
  if(diff)throw new AppError("UNAUTHORIZED","云端访问凭据无效。",401);
  if(request.headers.has("origin"))throw new AppError("ORIGIN_REJECTED","此接口仅供本地服务端调用。",403);
}
export async function body(request:Request):Promise<unknown> {
  if(request.headers.get("content-type")?.split(";")[0]!=="application/json")throw new AppError("INVALID_CONTENT_TYPE","请使用 JSON 请求。",415);
  if(Number(request.headers.get("content-length"))>65536)throw new AppError("BODY_TOO_LARGE","请求超过 64 KB。",413);
  const reader=request.body?.getReader();
  if(!reader)throw new AppError("INVALID_JSON","请求 JSON 无效。");
  const parts:Uint8Array[]=[];let size=0;
  while(true) {
    const {value,done}=await reader.read();if(done)break;
    size+=value.length;if(size>65536){await reader.cancel();throw new AppError("BODY_TOO_LARGE","请求超过 64 KB。",413);}
    parts.push(value);
  }
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new AppError("INVALID_JSON","请求 JSON 无效。");}
}
async function getJob(db:D1Database,id:string):Promise<JobRow> {
  const row=await db.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first<JobRow>();
  if(!row)throw new AppError("CLOUD_JOB_NOT_FOUND","未找到云端任务；不会自动重新提交。",404);
  return row;
}
function view(row:JobRow):CloudJobView {
  return {id:row.id,state:row.state,status:row.status_json?JSON.parse(row.status_json) as BriaStatusResponse:undefined,httpStatus:row.http_status??undefined};
}
async function expireSubmission(db:D1Database,row:JobRow) {
  if(row.state==="submitting"&&Date.now()-row.created_at>=SUBMIT_TIMEOUT) {
    await db.prepare("UPDATE jobs SET state='uncertain', error_code='SUBMISSION_UNCERTAIN', updated_at=? WHERE id=? AND state='submitting'").bind(Date.now(),row.id).run();
    return getJob(db,row.id);
  }
  return row;
}
export async function submit(request:Request,env:Env,bria:BriaHttpClient) {
  const input=parseCloudInput(await body(request));
  const canonical=JSON.stringify(input),fingerprint=Array.from(await digest(canonical),b=>b.toString(16).padStart(2,"0")).join("");
  const existing=await env.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(input.cloudJobId).first<JobRow>();
  if(existing) {
    if(existing.fingerprint!==fingerprint)throw new AppError("ID_CONFLICT","任务标识已用于其他参数。",409);
    return json(view(await expireSubmission(env.DB,existing)),202);
  }
  const upload=await env.DB.prepare("SELECT file_url, expires_at FROM uploads WHERE id=?").bind(input.uploadId).first<{file_url:string;expires_at:number}>();
  if(!upload||upload.expires_at<=Date.now())throw new AppError("UPLOAD_EXPIRED","上传引用不存在或已过期，请重新上传。",410);
  const now=Date.now();
  const inserted=await env.DB.prepare("INSERT INTO jobs (id,upload_id,fingerprint,params_json,state,created_at,updated_at) VALUES (?,?,?,?,'submitting',?,?) ON CONFLICT(id) DO NOTHING")
    .bind(input.cloudJobId,input.uploadId,fingerprint,canonical,now,now).run();
  if(!inserted.meta.changes) {
    const row=await getJob(env.DB,input.cloudJobId);
    if(row.fingerprint!==fingerprint)throw new AppError("ID_CONFLICT","任务标识已用于其他参数。",409);
    return json(view(await expireSubmission(env.DB,row)),202);
  }
  // The durable reservation is never reclaimed to POST again, even after a crash.
  let requestId:string;
  try {
    const result=input.mode==="auto"?await bria.autoForeground(upload.file_url,input.color)
      :input.mode==="prompt"?await bria.maskByPrompt(upload.file_url,input.prompt!)
      :await bria.maskByPoints(upload.file_url,input.frame_index!,input.key_points!);
    requestId=result.request_id;
  } catch(error) {
    // A timeout (including HTTP 408) cannot prove that the paid operation was rejected.
    const rejected=error instanceof BriaHttpError&&[400,401,403,404,405,413,415,422,429].includes(error.httpStatus);
    await env.DB.prepare("UPDATE jobs SET state=?,error_code=?,http_status=?,updated_at=? WHERE id=?")
      .bind(rejected?"rejected":"uncertain",rejected?"SUBMISSION_REJECTED":"SUBMISSION_UNCERTAIN",rejected?(error as BriaHttpError).httpStatus:null,Date.now(),input.cloudJobId).run();
    return json(view(await getJob(env.DB,input.cloudJobId)),202);
  }
  // If this write fails the original reservation remains: never classify it as rejection.
  await env.DB.prepare("UPDATE jobs SET state='processing',request_id=?,updated_at=?,next_poll_at=? WHERE id=?")
    .bind(requestId,Date.now(),Date.now()+POLL_INTERVAL,input.cloudJobId).run();
  return json(view(await getJob(env.DB,input.cloudJobId)),202);
}
export async function status(id:string,env:Env,bria:BriaHttpClient) {
  let row=await expireSubmission(env.DB,await getJob(env.DB,id));
  if(row.state!=="processing"||row.next_poll_at>Date.now())return json(view(row));
  const token=crypto.randomUUID(),now=Date.now();
  // The 70s lease covers the 60s upstream timeout; token fences late responses.
  const claim=await env.DB.prepare("UPDATE jobs SET poll_token=?,next_poll_at=? WHERE id=? AND state='processing' AND next_poll_at<=?")
    .bind(token,now+70_000,id,now).run();
  if(!claim.meta.changes)return json(view(await getJob(env.DB,id)));
  let result:BriaStatusResponse;
  try {result=await bria.status(row.request_id!);}
  catch(error) {
    if(error instanceof BriaHttpError&&error.httpStatus===404)result={status:"UNKNOWN"};
    else {
      const failures=row.poll_failures+1;
      const delay=Math.max(Math.min(5000*2**Math.min(failures,4),60000),error instanceof BriaHttpError?error.retryAfterMs:0);
      await env.DB.prepare("UPDATE jobs SET next_poll_at=?,poll_token=NULL,poll_failures=?,updated_at=? WHERE id=? AND poll_token=?")
        .bind(Date.now()+delay,failures,Date.now(),id,token).run();
      throw error;
    }
  }
  const state=result.status==="COMPLETED"?"completed":result.status==="IN_PROGRESS"?"processing":"failed";
  await env.DB.prepare("UPDATE jobs SET state=?,status_json=?,updated_at=?,next_poll_at=?,poll_token=NULL,poll_failures=0 WHERE id=? AND poll_token=?")
    .bind(state,JSON.stringify(result),Date.now(),Date.now()+POLL_INTERVAL,id,token).run();
  row=await getJob(env.DB,id);
  return json(view(row));
}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    try {
      await authenticate(request,env);
      if(!env.BRIA_API_TOKEN?.trim())throw new AppError("CLOUD_CONFIG","云端尚未配置 Bria 服务。",503);
      const path=new URL(request.url).pathname,bria=new BriaHttpClient(env.BRIA_API_TOKEN);
      if(request.method==="GET"&&path==="/v1/health") {
        await env.DB.prepare("SELECT id FROM jobs LIMIT 1").first();
        await env.DB.prepare("SELECT id FROM uploads LIMIT 1").first();
        return json({ok:true,service:"bria-cutout-cloud"});
      }
      if(request.method==="POST"&&path==="/v1/uploads") {
        if(Object.keys(object(await body(request))).length)throw new AppError("INVALID_INPUT","上传授权不接受额外参数。");
        const grant=await bria.uploadGrant(),id=crypto.randomUUID(),now=Date.now();
        await env.DB.prepare("INSERT INTO uploads (id,file_url,created_at,expires_at) VALUES (?,?,?,?)").bind(id,grant.file_url,now,now+86400_000).run();
        return json({uploadId:id,upload_url:grant.upload_url,upload_fields:grant.upload_fields},201);
      }
      if(request.method==="POST"&&path==="/v1/jobs")return await submit(request,env,bria);
      const match=/^\/v1\/jobs\/([^/]+)$/.exec(path);
      if(request.method==="GET"&&match)return await status(validId(match[1]),env,bria);
      throw new AppError("NOT_FOUND","接口不存在。",404);
    }catch(error) {
      if(error instanceof AppError)return json({code:error.code,message:error.message,...(error instanceof BriaHttpError?{upstreamStatus:error.httpStatus,retryAfterMs:error.retryAfterMs}:{})},error.statusCode);
      // Never serialize/log raw fetch or D1 exceptions: they can contain URLs and SQL params.
      return json({code:"CLOUD_STORAGE",message:"云端存储暂不可用，请稍后查询原任务。"},503);
    }
  },
};
