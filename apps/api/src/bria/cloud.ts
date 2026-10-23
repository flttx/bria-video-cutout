import { AppError, object } from "../errors.js";
import { validId } from "../model.js";
import type { ColorName } from "../model.js";
import type { MaskPoint } from "../config.js";
import type { BriaGateway, SubmitContext } from "./client.js";
import { downloadFile, uploadFile } from "./client.js";
import { BriaHttpError, mediaUrl } from "./protocol.js";
import type { BriaStatusResponse } from "./protocol.js";
import { parseCloudInput, parseCloudView } from "./cloud-contract.js";
import type { CloudJobView } from "./cloud-contract.js";

export class CloudBriaClient implements BriaGateway {
  readonly kind="cloud" as const;
  private readonly base:string;
  constructor(base:string,private readonly token:string,private readonly transport:typeof fetch=fetch,private readonly mediaTransport:typeof fetch=fetch) {
    let url:URL;
    try {url=new URL(base);}catch{throw new AppError("CLOUD_CONFIG","云端接口地址未配置或无效。",503);}
    const local=url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname);
    if((url.protocol!=="https:"&&!local)||url.username||url.password||url.search||url.hash||url.pathname!=="/"||token.trim().length<32)throw new AppError("CLOUD_CONFIG","请配置 HTTPS 云端地址和至少 32 字符的服务端凭据。",503);
    this.base=url.origin;
  }
  private async api(path:string,body?:unknown,timeoutMs=75_000):Promise<unknown> {
    let response:Response;
    try {response=await this.transport(this.base+path,{method:body===undefined?"GET":"POST",headers:{Authorization:`Bearer ${this.token}`,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),redirect:"error",signal:AbortSignal.timeout(timeoutMs)});}
    catch{throw new AppError("CLOUD_NETWORK","连接云端中断，请恢复查询原任务；不会自动重新提交。",502);}
    let data:Record<string,unknown>;
    try {data=object(await response.json());}catch{throw new AppError("CLOUD_RESPONSE","云端响应无效，请恢复查询原任务。",502);}
    if(!response.ok) {
      if(typeof data.upstreamStatus==="number"&&[401,403,404,408,429,500,502,503,504].includes(data.upstreamStatus))throw new BriaHttpError(data.upstreamStatus,typeof data.retryAfterMs==="number"?data.retryAfterMs:5000);
      if(data.code==="CLOUD_JOB_NOT_FOUND")throw new AppError("CLOUD_JOB_NOT_FOUND","云端没有此任务记录，请核对服务地址与原任务；不会自动重发。",409);
      if(response.status===401||response.status===403)throw new AppError("CLOUD_AUTH","云端鉴权失败，请检查服务端凭据。",503);
      // Do not reflect untrusted cloud messages, URL-bearing errors or HTTP bodies locally.
      throw new AppError("CLOUD_REQUEST","云端请求失败，请检查配置并恢复查询原任务。",502);
    }
    return data;
  }
  async health() {const data=object(await this.api("/v1/health",undefined,8000));if(data.ok!==true)throw new AppError("CLOUD_HEALTH","云端服务不可用。",503);}
  async upload(file:string):Promise<string> {
    const data=object(await this.api("/v1/uploads",{})),uploadId=validId(data.uploadId);
    const upload_url=mediaUrl(data.upload_url).href,upload_fields:Record<string,string>={};
    for(const [key,value] of Object.entries(object(data.upload_fields))) {
      if(typeof value!=="string")throw new AppError("CLOUD_RESPONSE","云端上传授权无效。",502);
      upload_fields[key]=value;
    }
    await uploadFile(file,{upload_url,upload_fields},this.mediaTransport);
    return uploadId;
  }
  private checked(view:CloudJobView):BriaStatusResponse {
    if(view.state==="uncertain")throw new AppError("SUBMISSION_UNCERTAIN","Bria 提交结果不明，请核对控制台；系统不会自动重发。",409);
    if(view.state==="rejected")throw new AppError("CLOUD_SUBMISSION_REJECTED",`Bria 拒绝了此次提交（HTTP ${view.httpStatus??400}）。修正输入或账号配置后可手动恢复。`,409);
    if(view.state==="completed"||view.state==="failed") {
      if(!view.status)throw new AppError("CLOUD_RESPONSE","云端终态缺少处理结果。",502);
      return view.status;
    }
    return {status:"IN_PROGRESS"};
  }
  private async submit(uploadId:string,params:Record<string,unknown>,context?:SubmitContext) {
    if(!context)throw new AppError("CLOUD_CONTEXT","云端任务缺少持久化标识。",500);
    const {width,height,duration,fps,frames}=context.meta;
    const input=parseCloudInput({cloudJobId:context.cloudJobId,uploadId,meta:{width,height,duration,fps,frames},...params});
    const view=parseCloudView(await this.api("/v1/jobs",input));
    if(view.id!==context.cloudJobId)throw new AppError("CLOUD_RESPONSE","云端任务标识不匹配。",502);
    this.checked(view);
    // Existing local pipeline treats this as an opaque lookup key, never a Bria ID.
    return {request_id:context.cloudJobId};
  }
  autoForeground(uploadId:string,color?:ColorName,context?:SubmitContext) {return this.submit(uploadId,{mode:"auto",...(color?{color}:{})},context);}
  maskByPrompt(uploadId:string,prompt:string,context?:SubmitContext) {return this.submit(uploadId,{mode:"prompt",prompt},context);}
  maskByPoints(uploadId:string,frame_index:number,key_points:MaskPoint[],context?:SubmitContext) {return this.submit(uploadId,{mode:"points",frame_index,key_points},context);}
  async status(id:string):Promise<BriaStatusResponse> {
    const view=parseCloudView(await this.api("/v1/jobs/"+validId(id)));
    if(view.id!==id)throw new AppError("CLOUD_RESPONSE","云端任务标识不匹配。",502);
    return this.checked(view);
  }
  download(url:string,file:string) {return downloadFile(url,file,this.mediaTransport);}
}
