import type { MaskPoint } from "../config.js";
import type { ColorName } from "../model.js";
import { AppError, object } from "../errors.js";
import { BriaCallError, briaOperation, safeNetworkCode } from './diagnostics.js';
import type { BriaCallDiagnostic } from './diagnostics.js';

const BASE_URL = "https://engine.prod.bria-api.com/v2";
export interface BriaSubmitResponse { request_id: string }
export interface BriaStatusResponse {
  status: "IN_PROGRESS" | "COMPLETED" | "ERROR" | "UNKNOWN";
  result?: { video_url?: string; mask_url?: string; image_url?: string; warning?: boolean };
}
export interface UploadGrant { upload_url: string; upload_fields: Record<string,string>; file_url: string }
// Only copy known fields. Upstream error bodies and warnings can contain private URLs.
export function parseStatus(value:unknown):BriaStatusResponse {
  const data=object(value);
  if(!["IN_PROGRESS","COMPLETED","ERROR","UNKNOWN"].includes(String(data.status)))throw new AppError("BRIA_RESPONSE","Bria 返回未知任务状态。",502);
  const parsed:BriaStatusResponse={status:data.status as BriaStatusResponse["status"]};
  if(data.result!==undefined) {
    const result=object(data.result);
    parsed.result={};
    for(const key of ["video_url","mask_url","image_url"] as const) {
      if(result[key]!==undefined) {
        if(typeof result[key]!=="string")throw new AppError("BRIA_RESPONSE","Bria 结果字段无效。",502);
        parsed.result[key]=mediaUrl(result[key]).href;
      }
    }
    if(result.warning)parsed.result.warning=true;
  }
  return parsed;
}
// Node additionally resolves DNS before transferring media. Workers never fetch these URLs.
export function mediaUrl(value:unknown):URL {
  if(typeof value!=="string")throw new AppError("INVALID_UPSTREAM_URL","Bria 文件地址无效。",502);
  let url:URL;
  try {url=new URL(value);}catch{throw new AppError("INVALID_UPSTREAM_URL","Bria 文件地址无效。",502);}
  if(url.protocol!=="https:"||url.username||url.password||(url.port&&url.port!=="443")||url.hostname.includes(":")||/^\d+(\.\d+){3}$/.test(url.hostname)||url.hostname==="localhost"||url.hostname.endsWith(".localhost"))throw new AppError("INVALID_UPSTREAM_URL","Bria 文件地址不安全。",502);
  return url;
}
export class BriaHttpError extends BriaCallError {
  constructor(readonly httpStatus:number, readonly retryAfterMs=5000, diagnostic:BriaCallDiagnostic={operation:'unknown',stage:'http',elapsedMs:0,httpStatus}) {
    super(`BRIA_HTTP_${httpStatus}`, httpStatus===401 ? "Bria Token 无效，请检查服务端配置。" : httpStatus===403 ? "当前 Bria 账号无此接口权限，请检查套餐。" : httpStatus===429 ? "Bria 请求限流，请稍后恢复任务。" : `Bria 请求失败（HTTP ${httpStatus}），请检查输入或账号服务状态。`,diagnostic);
  }
}
export class BriaHttpClient {
  constructor(private readonly token:string, private readonly transport:typeof fetch=(input,init)=>fetch(input,init)) {
    if(!token.trim())throw new AppError("TOKEN_MISSING","服务端尚未配置 Bria 服务。",503);
  }
  protected async api(path:string, body?:Record<string,unknown>):Promise<unknown> {
    const started=Date.now(),operation=briaOperation(path);
    let response:Response;
    try {
      response=await this.transport(BASE_URL+path,{
        method:body?"POST":"GET", headers:{api_token:this.token,"Content-Type":"application/json"},
        body:body?JSON.stringify(body):undefined, redirect:"manual",signal:AbortSignal.timeout(60000),
      });
    } catch(error) { throw new BriaCallError("BRIA_NETWORK","连接 Bria 超时或中断；提交请求不会自动重发。",{operation,stage:'network',elapsedMs:Date.now()-started,networkCode:safeNetworkCode(error)}); }
    if(!response.ok) {
      const retry=Number(response.headers.get("retry-after"));
      await response.body?.cancel().catch(()=>{});
      throw new BriaHttpError(response.status,Number.isFinite(retry)&&retry>0 ? Math.min(retry*1000,60000):5000,{operation,stage:'http',elapsedMs:Date.now()-started,httpStatus:response.status});
    }
    try { return await response.json(); } catch(error) { throw new BriaCallError("BRIA_RESPONSE","Bria 返回了无法解析的响应。",{operation,stage:'decode',elapsedMs:Date.now()-started,httpStatus:response.status,networkCode:safeNetworkCode(error)}); }
  }
  private async submit(path:string, body:Record<string,unknown>):Promise<BriaSubmitResponse> {
    const started=Date.now(),value=await this.api(path,body);
    const data=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
    if(typeof data.request_id!=="string" || !/^[a-zA-Z0-9_-]{4,160}$/.test(data.request_id)) throw new BriaCallError("BRIA_RESPONSE","Bria 提交结果缺少有效任务标识，请勿直接重复提交。",{operation:briaOperation(path),stage:'validate',elapsedMs:Date.now()-started});
    return {request_id:data.request_id};
  }
  async uploadGrant(mediaType="video/mp4"):Promise<UploadGrant> {
    const data=object(await this.api("/video/upload",{media_type:mediaType}));
    const result=object(data.result??data);
    const upload_url=mediaUrl(result.upload_url).href,file_url=mediaUrl(result.file_url).href;
    const upload_fields:Record<string,string>={};
    for(const [key,value] of Object.entries(object(result.upload_fields))) {
      if(typeof value!=="string")throw new AppError("BRIA_UPLOAD_RESPONSE","Bria 上传字段无效。",502);
      upload_fields[key]=value;
    }
    return {upload_url,file_url,upload_fields};
  }
  autoForeground(video:string,color?:ColorName):Promise<BriaSubmitResponse> {
    return this.submit("/video/edit/remove_background",{video,background_color:color??"Transparent",output_container_and_codec:color?"mp4_h264":"webm_vp9",auto_zoom:false,preserve_audio:true});
  }
  imageForeground(image:string):Promise<BriaSubmitResponse> {
    return this.submit("/image/edit/remove_background",{image,sync:false,preserve_alpha:true});
  }
  maskByPrompt(video:string,prompt:string):Promise<BriaSubmitResponse> {
    return this.submit("/video/segment/mask_by_prompt",{video,prompt,auto_trim:false,output_container_and_codec:"mp4_h264"});
  }
  maskByPoints(video:string,frame_index:number,key_points:MaskPoint[]):Promise<BriaSubmitResponse> {
    return this.submit("/video/segment/mask_by_key_points",{video,frame_index,key_points,auto_trim:false,output_container_and_codec:"mp4_h264"});
  }
  async status(id:string):Promise<BriaStatusResponse> {
    if(!/^[a-zA-Z0-9_-]{4,160}$/.test(id)) throw new AppError("BRIA_ID","Bria 任务标识无效。",500);
    const data=object(await this.api("/status/"+encodeURIComponent(id)));
    return parseStatus(data);
  }
}
