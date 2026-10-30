import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, object, publicError } from './errors.js';
import type { ImagePipeline, ImageRecord } from './images.js';
import { KLING_DURATION, KLING_MODEL, KLING_PROMPT } from './kling.js';
import type { KlingGateway, KlingRegion, KlingTask } from './kling.js';
import { command } from './media.js';
import { validId } from './model.js';
import type { Store } from './store.js';

export interface ImageVideoRecord {
  id:string;filename:string;createdAt:string;updatedAt:string;
  state:'queued'|'whitening'|'submitting'|'processing'|'downloading'|'completed'|'failed';
  region:KlingRegion;model:string;externalId:string;requestId?:string;submissionAttempted?:boolean;prompt?:string;
  providerStatus?:KlingTask['status'];lastCheckedAt?:string;
  canResume:boolean;error?:{code:string;message:string};meta?:{width:number;height:number;duration:number};
}
export function imageVideoView(item:ImageVideoRecord){return {id:item.id,filename:item.filename,state:item.state,createdAt:item.createdAt,
  canResume:item.canResume,error:item.error,meta:item.meta,providerStatus:item.providerStatus,lastCheckedAt:item.lastCheckedAt,sourceUrl:`/api/images/${item.id}/source`,
  videoUrl:item.state==='completed'?`/api/image-videos/${item.id}/file`:undefined};}
export class ImageVideoPipeline {
  private queue:Promise<void>=Promise.resolve();
  private mutation:Promise<void>=Promise.resolve();
  private active=new Set<string>();
  constructor(readonly store:Store,private readonly images:ImagePipeline,private readonly kling?:KlingGateway,private readonly pollMs=5000,private readonly timeout=1800000){}
  get available(){return !!this.kling;}
  async idle(){await this.queue;}
  private async save(item:ImageVideoRecord){item.updatedAt=new Date().toISOString();await this.store.save('image-videos',item);}
  private enqueue(id:string){
    if(this.active.has(id))return;this.active.add(id);
    // One process owns the durable intent and queue, matching standalone deployment.
    this.queue=this.queue.then(()=>this.run(id)).catch(()=>console.error('IMAGE_VIDEO_STORAGE_FAILURE')).finally(()=>this.active.delete(id));
  }
  async initialize(){for(const item of await this.store.list<ImageVideoRecord>('image-videos'))if(!['completed','failed'].includes(item.state))this.enqueue(item.id);}
  async start(id:string){
    const previous=this.mutation;let unlock!:()=>void;this.mutation=new Promise<void>(resolve=>{unlock=resolve;});await previous;
    try{
      const source=await this.images.get(validId(id));
      if((source.provider??'bria')!=='bria'||source.sourceId)throw new AppError('KLING_BRIA_ONLY','可灵旋转视频仅使用 Bria 白底结果，请切换至 Bria。',422);
      let item:ImageVideoRecord|undefined;
      try{item=await this.store.get<ImageVideoRecord>('image-videos',id);}catch(error){if(!(error instanceof AppError)||error.code!=='NOT_FOUND')throw error;}
      if(item&&(this.active.has(id)||item.state==='completed'))return item;
      if(!this.kling)throw new AppError('KLING_UNAVAILABLE','请在服务端配置 KLING_API_KEY 后生成视频。',503);
      if(item&&item.region!==this.kling.region)throw new AppError('KLING_REGION_CHANGED','请恢复此任务原有的可灵区域配置。',409);
      if(item?.state==='failed'&&!item.canResume)throw new AppError('KLING_CANNOT_RESUME','原任务已失败，请先核对平台结果；不会自动重新计费生成。',409);
      const {width,height}=source.outputMeta??source.meta;
      if(width<300||height<300||width/height<0.4||width/height>2.5)throw new AppError('KLING_IMAGE_DIMENSIONS','可灵要求图片宽高均至少 300px，宽高比在 1:2.5 至 2.5:1 之间。',422);
      if(source.state!=='completed'&&!this.images.providers.bria)throw new AppError('BRIA_IMAGE_UNAVAILABLE','请在服务端启用 Bria 图片去背景服务。',503);
      const now=new Date().toISOString();
      item??={id,filename:source.filename,createdAt:now,updatedAt:now,state:'queued',region:this.kling.region,model:KLING_MODEL,externalId:`white-${id}`,canResume:false};
      item.state='queued';item.canResume=false;delete item.error;await this.save(item);this.enqueue(id);return item;
    }finally{unlock();}
  }
  private async run(id:string){
    const item=await this.store.get<ImageVideoRecord>('image-videos',id);
    try{
      const kling=this.kling;
      if(!kling||kling.region!==item.region)throw new AppError('KLING_UNAVAILABLE','请恢复此任务原有的可灵服务及区域配置。',503);
      if(!item.submissionAttempted){
        item.state='whitening';await this.save(item);
        let source=await this.images.get(id);
        if(source.state!=='completed'){
          await this.images.start(id,'bria');const until=Date.now()+this.timeout;
          for(;;){
            source=await this.images.get(id);
            if(source.state==='completed')break;
            if(source.state==='failed'){
              const uncertain=source.submissionAttempted&&!source.requestId&&!source.canResume;
              throw new AppError(uncertain?'BRIA_WHITE_UNCERTAIN':'BRIA_WHITE_FAILED',uncertain?
                'Bria 白底请求提交时连接中断或响应未确认，未取得任务号。为避免重复计费，已暂停；请核对平台任务或由服务端复用同图已完成的白底结果。':
                `Bria 白底图片处理未完成。${source.error?.message??''}${source.canResume?'可恢复原任务继续处理。':'当前任务不能直接恢复，请核对原任务结果。'}`,422);
            }
            if(Date.now()>until)throw new AppError('BRIA_WHITE_TIMEOUT','白底图片处理等待超时，可恢复原任务。',504);
            await delay(this.pollMs);
          }
        }
        const file=this.store.path('images',id,'white.png');
        if((await stat(file)).size>50_000_000)throw new AppError('KLING_IMAGE_SIZE','白底图片超过可灵 50 MB 输入上限。',413);
        // Persist BEFORE networking. A lost response is reconciled by external ID, never resubmitted.
        item.state='submitting';item.submissionAttempted=true;item.prompt=KLING_PROMPT;await this.save(item);
        item.requestId=await kling.submit(file,item.externalId);await this.save(item);
      }
      item.state='processing';await this.save(item);const until=Date.now()+this.timeout;
      for(;;){
        if(Date.now()>until)throw new AppError('KLING_TIMEOUT','可灵视频等待超时，可继续查询原任务。',504);
        const result=await kling.query(item.requestId??item.externalId,!item.requestId);
        if(!result)throw new AppError('KLING_SUBMISSION_UNCERTAIN','尚未查到原可灵任务，可稍后恢复查询；不会再次提交或计费。',409);
        item.requestId??=result.id;item.providerStatus=result.status;item.lastCheckedAt=new Date().toISOString();await this.save(item);
        if(result.status==='failed')throw new AppError('KLING_TASK_FAILED','可灵视频生成失败，请核对原任务与素材。',422);
        if(result.status==='succeeded'){
          if(!result.url)throw new AppError('KLING_RESULT_MISSING','可灵结果缺少视频地址，可恢复查询。',502);
          item.state='downloading';await this.save(item);
          const folder=this.store.path('image-videos',id,'');await mkdir(folder,{recursive:true});
          const file=this.store.path('image-videos',id,'result.part.mp4');
          try{
            await kling.download(result.url,file,250*1024*1024);
            const info=JSON.parse(await command('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',file],30000)) as {streams?:{codec_type?:string;codec_name?:string;width?:number;height?:number}[];format?:{format_name?:string;duration?:string}};
            const streams=info.streams??[],video=streams.find(stream=>stream.codec_type==='video'),duration=Number(info.format?.duration);
            if(!/mp4|mov/.test(info.format?.format_name??'')||streams.length!==1||video?.codec_name!=='h264'||!video.width||!video.height||video.width>4096||video.height>4096||Math.min(video.width,video.height)<1000||!Number.isFinite(duration)||Math.abs(duration-KLING_DURATION)>0.5)
              throw new AppError('KLING_VIDEO_INVALID','可灵视频格式、尺寸或时长不符合本次请求，已停止交付。',422);
            await command('ffmpeg',['-v','error','-nostdin','-xerror','-protocol_whitelist','file,pipe','-i',file,'-map','0:v:0','-f','null','-'],120000);
            item.meta={width:video.width,height:video.height,duration};
            await rename(file,this.store.path('image-videos',id,'result.mp4'));
          }finally{await rm(file,{force:true});}
          item.state='completed';item.canResume=false;delete item.error;await this.save(item);return;
        }
        await delay(this.pollMs);
      }
    }catch(error){
      item.state='failed';item.error=publicError(error);item.canResume=!['KLING_TASK_FAILED','KLING_VIDEO_INVALID','KLING_IMAGE_SIZE'].includes(item.error.code);
      if(!item.submissionAttempted){const source:ImageRecord=await this.images.get(id);if(source.state==='failed'&&!source.canResume)item.canResume=false;}
      await this.save(item);
    }
  }
}
export function registerImageVideoRoutes(app:FastifyInstance,engine:ImageVideoPipeline){
  app.post('/api/image-videos',async(request,reply)=>reply.code(202).send(imageVideoView(await engine.start(validId(object(request.body).imageId)))));
  app.get('/api/image-videos',async()=> (await engine.store.list<ImageVideoRecord>('image-videos')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20).map(imageVideoView));
  app.get<{Params:{id:string}}>('/api/image-videos/:id',async request=>imageVideoView(await engine.store.get<ImageVideoRecord>('image-videos',validId(request.params.id))));
  app.get<{Params:{id:string};Querystring:{download?:string}}>('/api/image-videos/:id/file',async(request,reply)=>{
    const item=await engine.store.get<ImageVideoRecord>('image-videos',validId(request.params.id));
    if(item.state!=='completed')throw new AppError('KLING_VIDEO_NOT_READY','视频尚未生成完成。',409);
    const file=engine.store.path('image-videos',item.id,'result.mp4'),size=(await stat(file)).size;
    reply.type('video/mp4').header('Accept-Ranges','bytes').header('Content-Disposition',`${request.query.download==='1'?'attachment':'inline'}; filename="kling-white-${item.id.slice(0,8)}.mp4"`);
    let start=0,end=size-1;
    if(request.headers.range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if(!match||(!match[1]&&!match[2]))return reply.code(416).header('Content-Range',`bytes */${size}`).send();
      if(!match[1])start=Math.max(0,size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(size-1,Number(match[2]));}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size)return reply.code(416).header('Content-Range',`bytes */${size}`).send();
      reply.code(206).header('Content-Range',`bytes ${start}-${end}/${size}`);
    }
    return reply.header('Content-Length',end-start+1).send(createReadStream(file,{start,end}));
  });
}
