import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { BriaGateway, BriaStatusResponse } from "./bria/client.js";
import { BriaHttpError } from "./bria/client.js";
import { AppError, object, publicError } from "./errors.js";
import { exportOptions, parseJob, validId } from "./model.js";
import type { ExportRecord, JobRecord, VideoRecord } from "./model.js";
import { Store } from "./store.js";
import { prepare, proxy, render, validateArtifact } from "./media.js";

export function jobView(job:JobRecord) {
  return { id:job.id, state:job.state, input:job.input, createdAt:job.createdAt, updatedAt:job.updatedAt, exportId:job.exportId, error:job.error, canResume:job.canResume??false, reusable:job.artifact!=="direct", warning:job.warning, sourceMeta:job.sourceMeta&&{width:job.sourceMeta.width,height:job.sourceMeta.height,fps:job.sourceMeta.fps} };
}
export function exportView(item:ExportRecord) {
  return {...item, downloadUrl:item.state==="completed"?`/api/exports/${item.id}/file`:undefined};
}
export class Pipeline {
  private queue:Promise<void>=Promise.resolve();
  private mutation:Promise<void>=Promise.resolve();
  private active=new Set<string>();
  constructor(readonly store:Store,private readonly bria:BriaGateway|undefined,private readonly pollMs=5000,private readonly pollTimeout=1_800_000,private readonly gateways:Partial<Record<"direct"|"cloud",BriaGateway>>={}) {}
  private gateway(job:JobRecord) {
    const mode=job.transport??"direct";
    const gateway=this.gateways[mode]??((this.bria?.kind??"direct")===mode?this.bria:undefined);
    if(!gateway)throw new AppError("SERVICE_NOT_CONFIGURED",`此任务所用的 ${mode} 服务未配置，请恢复原服务配置。`,503);
    return gateway;
  }
  private async exclusive<T>(fn:()=>Promise<T>):Promise<T> {
    const previous=this.mutation;
    let unlock!:()=>void;
    this.mutation=new Promise<void>(resolve=>{unlock=resolve;});
    await previous;
    try{return await fn();}finally{unlock();}
  }
  private enqueue(key:string,fn:()=>Promise<void>) {
    if(this.active.has(key))return;
    this.active.add(key);
    this.queue=this.queue.then(fn).catch(()=>{
      // Only catastrophic store failures reach here. Do not log errors containing paths.
      console.error("LOCAL_JOB_STORAGE_FAILURE");
    }).finally(()=>this.active.delete(key));
  }
  async idle() {await this.queue;}
  async setHistoryRemoved(id:string,removed:boolean):Promise<void> {
    await this.exclusive(async()=>{
      const job=await this.store.get<JobRecord>("jobs",validId(id));
      if(removed===!!job.removedAt)return;
      if(removed) {
        const exports=await this.store.list<ExportRecord>("exports");
        if(!["completed","failed"].includes(job.state)||this.active.has(`job:${id}`)||exports.some(item=>item.jobId===id&&(["queued","exporting"].includes(item.state)||this.active.has(`export:${item.id}`)))) {
          throw new AppError("TASK_ACTIVE","任务正在处理或导出，请结束后再移除记录。",409);
        }
        job.removedAt??=new Date().toISOString();
      } else delete job.removedAt;
      await this.save(job);
    });
  }
  async initialize() {
    const jobs=await this.store.list<JobRecord>("jobs");
    for(const job of jobs) {
      if(job.state!=="completed"&&job.state!=="failed") this.enqueue(`job:${job.id}`,()=>this.run(job.id));
    }
    for(const item of await this.store.list<ExportRecord>("exports")) {
      if(item.state!=="queued"&&item.state!=="exporting")continue;
      const job=await this.store.get<JobRecord>("jobs",item.jobId);
      if(job.state==="completed")this.enqueue(`export:${item.id}`,()=>this.runExport(item.id));
    }
  }
  async create(value:unknown):Promise<JobRecord> {
    return this.exclusive(async()=>{
      if(!this.bria)throw new AppError("SERVICE_NOT_CONFIGURED","处理服务尚未配置，请检查服务端配置并重启。",503);
      const v=object(value),id=validId(v.id);
      const video=await this.store.get<VideoRecord>("videos",validId(v.videoId));
      const input=parseJob(v,video.meta);
      try {
        const existing=await this.store.get<JobRecord>("jobs",id);
        if(JSON.stringify(existing.input)!==JSON.stringify(input))throw new AppError("ID_CONFLICT","此请求标识已用于其他参数，请重新创建任务。",409);
        return existing;
      }catch(e){if(!(e instanceof AppError)||e.code!=="NOT_FOUND")throw e;}
      const now=new Date().toISOString();
      const job:JobRecord={id,input,state:"queued",createdAt:now,updatedAt:now,transport:this.bria.kind??"direct"};
      await this.store.save("jobs",job);
      this.enqueue(`job:${id}`,()=>this.run(id));
      return job;
    });
  }
  async resume(id:string):Promise<JobRecord> {
    return this.exclusive(async()=>{
      const job=await this.store.get<JobRecord>("jobs",validId(id));
      if(this.active.has(`job:${id}`))return job;
      if(job.state!=="failed"||!job.canResume)throw new AppError("CANNOT_RESUME","此任务不能自动恢复。提交结果不明时请先核对 Bria 控制台，避免重复计费。",409);
      // Only an explicit user resume of a confirmed rejection creates a new cloud attempt.
      if(job.transport==="cloud"&&job.error?.code==="CLOUD_SUBMISSION_REJECTED") {
        delete job.cloudJobId;delete job.requestId;job.submissionAttempted=false;
      }
      job.state="queued";delete job.error;delete job.removedAt;job.canResume=false;
      await this.save(job);
      this.enqueue(`job:${id}`,()=>this.run(id));
      return job;
    });
  }
  async createExport(jobId:string,value:unknown):Promise<ExportRecord> {
    return this.exclusive(async()=>{
      const v=object(value),id=validId(v.id),options=exportOptions(v);
      const job=await this.store.get<JobRecord>("jobs",validId(jobId));
      if(!job.artifactReady||!job.sourceMeta||job.state!=="completed")throw new AppError("NOT_READY","请等待当前处理完成后再导出。",409);
      if(job.artifact==="direct"&&options.color!==job.input.color)throw new AppError("COLOR_REQUIRES_AI","此任务未缓存透明结果。更换颜色需新建抠图任务；可重复换色模式可避免后续重复调用 Bria。",409);
      try {
        const existing=await this.store.get<ExportRecord>("exports",id);
        if(existing.jobId!==jobId||existing.color!==options.color||existing.resolution!==options.resolution)throw new AppError("ID_CONFLICT","导出标识已用于其他参数。",409);
        return existing;
      }catch(e){if(!(e instanceof AppError)||e.code!=="NOT_FOUND")throw e;}
      const item:ExportRecord={id,jobId,...options,state:"queued",createdAt:new Date().toISOString()};
      // A new export must be visible again so its progress remains reachable.
      if(job.removedAt){delete job.removedAt;await this.save(job);}
      await this.store.save("exports",item);
      this.enqueue(`export:${id}`,()=>this.runExport(id));
      return item;
    });
  }
  private save(job:JobRecord) {job.updatedAt=new Date().toISOString();return this.store.save("jobs",job);}
  private async state(job:JobRecord,state:JobRecord["state"]) {job.state=state;await this.save(job);}
  private async poll(bria:BriaGateway,id:string):Promise<BriaStatusResponse> {
    const end=Date.now()+this.pollTimeout;
    let failures=0;
    while(Date.now()<end) {
      await delay(this.pollMs);
      try {
        const result=await bria.status(id);
        if(result.status==="COMPLETED")return result;
        if(result.status==="ERROR"||result.status==="UNKNOWN")throw new AppError("BRIA_TERMINAL",result.status==="ERROR"?"Bria 未能完成此任务，请检查目标描述或视频内容；再次处理将创建新任务。":"Bria 任务不存在或已过期，请核对控制台。",502);
        failures=0;
      }catch(e){
        if(e instanceof AppError && (e.code==="BRIA_TERMINAL" || e.code==="BRIA_HTTP_404"))throw e;
        const transient=e instanceof BriaHttpError?(e.httpStatus===429||e.httpStatus>=500):e instanceof AppError&&["BRIA_NETWORK","CLOUD_NETWORK","CLOUD_REQUEST"].includes(e.code);
        if(!transient||++failures>3)throw e;
        await delay(Math.max(this.pollMs*2**failures,e instanceof BriaHttpError?e.retryAfterMs:0));
      }
    }
    throw new AppError("POLL_TIMEOUT","等待 Bria 超时。可恢复查询原任务，不会重复提交。",504);
  }
  private async run(id:string) {
    const job=await this.store.get<JobRecord>("jobs",id);
    try {
      const source=this.store.path("jobs",id,"source.mp4");
      if(!job.artifactReady) {
        const bria=this.gateway(job);
        // No cloud POST on recovery: the persisted key resolves the original D1 reservation.
        if(job.transport==="cloud"&&job.submissionAttempted&&!job.requestId&&job.cloudJobId) {
          job.requestId=job.cloudJobId;await this.save(job);
        }
        if(!job.requestId) {
          if(job.submissionAttempted)throw new AppError("SUBMISSION_UNCERTAIN","上次提交响应未保存，Bria 可能已创建任务。请核对控制台，系统不会自动重复提交。",409);
          await this.state(job,"preparing");
          const video=await this.store.get<VideoRecord>("videos",job.input.videoId);
          job.sourceMeta=await prepare(this.store.path("videos",video.id,"source"),source,job.input,video.meta);
          let upload=source;
          let proxyMeta=job.sourceMeta;
          if(job.input.mode!=="auto") {
            upload=this.store.path("jobs",id,"proxy.mp4");proxyMeta=await proxy(source,upload);
          }
          job.artifact=job.input.mode!=="auto"?"mask":job.input.reusable?"alpha":"direct";
          await this.state(job,"uploading");
          if(job.transport==="cloud") {job.cloudJobId??=randomUUID();await this.save(job);}
          const url=await bria.upload(upload);
          const context=job.cloudJobId?{cloudJobId:job.cloudJobId,meta:proxyMeta}:undefined;
          job.submissionAttempted=true;
          await this.state(job,"submitting");
          const result=job.input.mode==="auto" ? await bria.autoForeground(url,job.input.reusable?undefined:job.input.color,context)
            : job.input.mode==="prompt" ? await bria.maskByPrompt(url,job.input.prompt,context)
            : await bria.maskByPoints(url,Math.min(proxyMeta.frames-1,Math.max(0,Math.floor((job.input.points[0]!.atSeconds-job.input.start)*proxyMeta.fps))),job.input.points.map(p=>({x:Math.min(proxyMeta.width-1,Math.floor(p.x*proxyMeta.width)),y:Math.min(proxyMeta.height-1,Math.floor(p.y*proxyMeta.height)),type:p.type})),context);
          job.requestId=result.request_id;
          await this.save(job);
        }
        await this.state(job,"processing");
        const result=await this.poll(bria,job.requestId!);
        if(result.result?.warning) {
          job.warning="Bria 返回了输出格式警告，请核对结果。";
          if(job.artifact==="alpha")throw new AppError("ALPHA_WARNING","Bria 返回透明输出警告，已停止合成以避免交付不透明结果。",422);
        }
        const url=job.artifact==="mask"?(result.result?.mask_url??result.result?.video_url):result.result?.video_url;
        if(!url)throw new AppError("RESULT_MISSING","Bria 完成响应缺少视频结果字段。",502);
        await this.state(job,"downloading");
        const artifact=this.store.path("jobs",id,"artifact");
        await bria.download(url,artifact);
        await validateArtifact(artifact,job.sourceMeta!,job.artifact!);
        job.artifactReady=true;
        await this.save(job);
      }
      // Deterministic first-export ID makes crash recovery idempotent too.
      job.exportId=id;
      const item:ExportRecord={id,jobId:id,color:job.input.color,resolution:job.input.resolution,state:"queued",createdAt:new Date().toISOString()};
      await this.store.save("exports",item);
      await this.state(job,"exporting");
      await this.renderExport(item);
      delete job.error;job.canResume=false;
      await this.state(job,"completed");
    }catch(e){
      // A rejected 4xx POST has no accepted task; explicit resume can submit after correction.
      if(job.transport!=="cloud"&&job.state==="submitting" && e instanceof BriaHttpError && e.httpStatus>=400 && e.httpStatus<500&&e.httpStatus!==408)job.submissionAttempted=false;
      job.error=publicError(e);
      job.canResume=!!job.artifactReady || (!!job.requestId && !["BRIA_TERMINAL","BRIA_HTTP_404"].includes(job.error.code)) || !job.submissionAttempted;
      if(job.transport==="cloud"&&job.cloudJobId&&job.submissionAttempted) {
        // Resume means lookup only, except the explicitly confirmed rejection handled above.
        job.canResume=!["SUBMISSION_UNCERTAIN","CLOUD_JOB_NOT_FOUND","BRIA_TERMINAL","RESULT_EXPIRED"].includes(job.error.code);
      } else if(job.submissionAttempted&&!job.requestId)job.error={code:"SUBMISSION_UNCERTAIN",message:"Bria 提交结果不明，可能已计费。请核对控制台；系统不会自动重复提交。"};
      await this.state(job,"failed");
    }
  }
  private async renderExport(item:ExportRecord) {
    try {
      const job=await this.store.get<JobRecord>("jobs",item.jobId);
      if(!job.artifactReady||!job.sourceMeta||!job.artifact)throw new AppError("NOT_READY","中间结果尚不可用。",409);
      await mkdir(this.store.path("exports",item.id,""),{recursive:true});
      item.state="exporting";delete item.error;await this.store.save("exports",item);
      const result=await render(this.store.path("jobs",job.id,"source.mp4"),this.store.path("jobs",job.id,"artifact"),job.artifact,this.store.path("exports",item.id,"output.mp4"),item,job.sourceMeta);
      Object.assign(item,result);item.state="completed";await this.store.save("exports",item);
    }catch(e){item.state="failed";item.error=publicError(e);await this.store.save("exports",item);throw e;}
  }
  private async runExport(id:string) {
    const item=await this.store.get<ExportRecord>("exports",id);
    try{await this.renderExport(item);}catch{/* renderExport persisted the sanitized failure. */}
  }
}
