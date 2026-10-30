import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { BriaGateway } from './bria/client.js';
import { BriaHttpError } from './bria/client.js';
import { AppError, object, publicError } from './errors.js';
import type { TripoImageGateway, TripoRegion } from './tripo.js';
import { command } from './media.js';
import { validId } from './model.js';
import type { Store } from './store.js';

// Engineering budgets, not Bria API limits. PNG/JPEG only in the first release.
export const IMAGE_MAX_BYTES=20*1024*1024;
const RESULT_MAX_BYTES=100*1024*1024;
interface ImageMeta {width:number;height:number;alpha:boolean}
export type ImageProvider='bria'|'tripo';
function providerName(value:unknown):ImageProvider {
  if(value===undefined)return 'bria';
  if(value==='bria'||value==='tripo')return value;
  throw new AppError('IMAGE_PROVIDER','图片 API 仅支持 Bria 或 Tripo。');
}
export interface ImageRecord {
  id:string;filename:string;meta:ImageMeta;createdAt:string;updatedAt:string;
  sourceId?:string;provider?:ImageProvider;region?:TripoRegion;model?:string;fileToken?:string;outputMeta?:ImageMeta;
  state:'uploaded'|'queued'|'submitting'|'processing'|'downloading'|'composing'|'completed'|'failed';
  providerStatus?:string;lastCheckedAt?:string;
  requestId?:string;submissionAttempted?:boolean;artifactReady?:boolean;
  error?:{code:string;message:string};canResume?:boolean;
}
export function imageView(item:ImageRecord) {
  return {id:item.id,sourceId:item.sourceId??item.id,provider:item.provider??'bria',filename:item.filename,meta:item.meta,outputMeta:item.outputMeta,state:item.state,createdAt:item.createdAt,
    updatedAt:item.updatedAt,providerStatus:item.providerStatus,lastCheckedAt:item.lastCheckedAt,
    error:item.error,canResume:item.canResume??false,sourceUrl:`/api/images/${item.sourceId??item.id}/source`,
    downloadUrl:item.state==='completed'?`/api/images/${item.id}/file`:undefined};
}
async function imageMeta(file:string):Promise<ImageMeta> {
  const data=await readFile(file);
  if(data.length>RESULT_MAX_BYTES)throw new AppError('IMAGE_TOO_LARGE','图片超过本地处理上限。',413);
  const png=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg=data[0]===255&&data[1]===216&&data[2]===255;
  if(!png&&!jpeg)throw new AppError('IMAGE_FORMAT','请选择有效的 PNG 或 JPG 静态图片。',415);
  const raw=await command('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-of','json',file],30000);
  const info=JSON.parse(raw) as {streams?:{codec_name?:string;width?:number;height?:number;pix_fmt?:string}[]};
  const stream=info.streams?.[0],width=stream?.width??0,height=stream?.height??0;
  if(info.streams?.length!==1||!['png','mjpeg'].includes(stream?.codec_name??'')||width<1||height<1||width>8192||height>8192||width*height>24_000_000)
    throw new AppError('IMAGE_DIMENSIONS','仅支持静态 PNG/JPG，单边不超过 8192 像素、总像素不超过 2400 万。',422);
  return {width,height,alpha:/^(rgba|bgra|argb|abgr|gbrap|ya)/.test(stream?.pix_fmt??'')||stream?.pix_fmt==='pal8'};
}
const imageCommand=(args:string[])=>command('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-threads','2','-filter_complex_threads','1','-filter_threads','1',...args],120000);
async function normalizeImage(source:string,output:string) {
  await imageMeta(source);
  // Fully decode before any paid call; autorotate and normalize color/alpha once.
  const decoded=JSON.parse(await command('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-count_frames','-show_entries','stream=nb_read_frames','-of','json',source],30000)) as {streams?:{nb_read_frames?:string}[]};
  if(Number(decoded.streams?.[0]?.nb_read_frames)!==1)throw new AppError('IMAGE_ANIMATED','仅支持单张静态图片，不支持动图。',422);
  await imageCommand(['-xerror','-protocol_whitelist','file,pipe','-i',source,'-frames:v','1','-vf','format=rgba','-c:v','png',output]);
  const meta=await imageMeta(output);
  if((await stat(output)).size>IMAGE_MAX_BYTES)throw new AppError('IMAGE_TOO_LARGE','规范化后的图片超过 20 MiB，请缩小图片。',413);
  return meta;
}
async function whiteImage(source:string,output:string,expected?:ImageMeta) {
  const meta=await imageMeta(source);
  if(expected&&(!meta.alpha||meta.width!==expected.width||meta.height!==expected.height))throw new AppError('IMAGE_RESULT_INVALID','抠图结果缺少透明通道或尺寸不一致，已停止导出。',422);
  const temp=output+'.part.png';
  try {
    await imageCommand(['-xerror','-protocol_whitelist','file,pipe','-i',source,
      '-filter_complex','[0:v]format=rgba,split[fg][bg];[bg]lutrgb=r=255:g=255:b=255:a=255[white];[white][fg]overlay=format=rgb:shortest=1,format=rgb24[out]',
      '-map','[out]','-frames:v','1','-c:v','png',temp]);
    const result=await imageMeta(temp);
    if(result.alpha||result.width!==meta.width||result.height!==meta.height)throw new AppError('IMAGE_OUTPUT_INVALID','白底图片导出校验失败。',422);
    await rename(temp,output);
    return result;
  } finally {await rm(temp,{force:true});}
}

export class ImagePipeline {
  private queue:Promise<void>=Promise.resolve();
  private mutation:Promise<void>=Promise.resolve();
  private active=new Set<string>();
  constructor(readonly store:Store,private readonly bria:BriaGateway|undefined,private readonly pollMs=5000,private readonly timeout=600000,private readonly tripo?:TripoImageGateway) {}
  get providers() {return {bria:!!this.bria?.imageForeground&&this.bria.kind!=='cloud',tripo:!!this.tripo};}
  get available() {return this.providers.bria||this.providers.tripo;}
  async progress(id:string) {
    const item=await this.get(id);
    let state=item.state,downloadedBytes:number|undefined,lastProgressAt:string|undefined;
    // Read the actual partial file; no fake percentages or per-chunk database writes.
    if(state==='processing'||state==='downloading') {
      try {
        const file=await stat(this.store.path('images',id,'alpha.png.part'));
        state='downloading';downloadedBytes=file.size;lastProgressAt=file.mtime.toISOString();
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    return {state,updatedAt:item.updatedAt,providerStatus:item.providerStatus,lastCheckedAt:item.lastCheckedAt,
      downloadedBytes,lastProgressAt,
      stalled:state==='downloading'&&Date.now()-Date.parse(lastProgressAt??item.updatedAt)>60000};
  }
  async get(id:string,provider?:ImageProvider):Promise<ImageRecord> {
    const item=await this.store.get<ImageRecord>('image-jobs',validId(id));
    if(!provider||provider===(item.provider??'bria'))return item;
    const source=await this.store.get<ImageRecord>('image-jobs',item.sourceId??item.id);
    if(provider==='bria')return source;
    // A stable per-source variant keeps retries and response-loss recovery on the same job.
    const hex=createHash('sha256').update(`tripo:${source.id}`).digest('hex');
    const variantId=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
    try{return await this.store.get<ImageRecord>('image-jobs',variantId);}
    catch(error){if(!(error instanceof AppError)||error.code!=='NOT_FOUND')throw error;}
    return {id:variantId,sourceId:source.id,provider,filename:source.filename,meta:source.meta,state:'uploaded',createdAt:source.createdAt,updatedAt:source.updatedAt};
  }
  async idle(){await this.queue;}
  private async save(item:ImageRecord) {item.updatedAt=new Date().toISOString();await this.store.save('image-jobs',item);}
  private enqueue(id:string) {
    if(this.active.has(id))return;
    this.active.add(id);
    // ponytail: one image queue per API process; use a shared worker queue before multi-instance deployment.
    this.queue=this.queue.then(()=>this.run(id)).catch(()=>console.error('IMAGE_JOB_STORAGE_FAILURE')).finally(()=>this.active.delete(id));
  }
  async initialize() {
    for(const item of await this.store.list<ImageRecord>('image-jobs'))
      if(!['uploaded','completed','failed'].includes(item.state))this.enqueue(item.id);
  }
  async start(id:string,provider?:ImageProvider) {
    const previous=this.mutation;let unlock!:()=>void;
    this.mutation=new Promise<void>(resolve=>{unlock=resolve;});await previous;
    try {
      const item=await this.get(id,provider);id=item.id;
      const selected=item.provider??'bria';
      if(this.active.has(id)||item.state==='completed')return item;
      if(!this.providers[selected])throw new AppError('IMAGE_SERVICE_UNAVAILABLE',`${selected==='tripo'?'Tripo':'Bria'} 图片服务尚未配置，请检查服务端配置。`,503);
      if(selected==='tripo') {
        if(item.region&&item.region!==this.tripo!.region)throw new AppError('TRIPO_REGION_CHANGED','请恢复此任务原有的 Tripo 区域配置后继续。',409);
        const {width,height}=item.meta;
        if(width<14||height<14||width/height<1/3||width/height>3)throw new AppError('TRIPO_IMAGE_DIMENSIONS','Tripo 图片宽高至少 14px，宽高比须在 1:3 至 3:1 之间。',422);
        if((await stat(this.store.path('images',item.sourceId??id,'source.png'))).size>20_000_000)throw new AppError('TRIPO_IMAGE_SIZE','Tripo 规范化图片不能超过 20 MB。',413);
        item.region=this.tripo!.region;item.model='seedream_v5';
      }
      if(item.state==='failed'&&!item.canResume)throw new AppError('IMAGE_CANNOT_RESUME','此任务不能直接重试；提交结果不明时请先核对原平台任务，避免重复计费。',409);
      await mkdir(this.store.path('images',id,''),{recursive:true});
      item.state='queued';delete item.error;item.canResume=false;await this.save(item);
      this.enqueue(id);return item;
    }finally{unlock();}
  }
  private async run(id:string) {
    const item=await this.store.get<ImageRecord>('image-jobs',id);
    try {
      const isTripo=item.provider==='tripo';
      if(!this.providers[isTripo?'tripo':'bria'])throw new AppError('IMAGE_SERVICE_UNAVAILABLE','图片白底服务尚未配置。',503);
      if(isTripo&&item.region!==this.tripo!.region)throw new AppError('TRIPO_REGION_CHANGED','请恢复此任务原有的 Tripo 区域配置后继续。',409);
      const gateway=isTripo?this.tripo!:this.bria!;
      if(!item.requestId) {
        if(item.submissionAttempted)throw new AppError('SUBMISSION_UNCERTAIN','上次提交结果不明，请先核对原平台任务；系统不会自动再次收费提交。',409);
        const source=this.store.path('images',item.sourceId??id,'source.png');
        if(isTripo&&!item.fileToken){item.fileToken=await this.tripo!.upload(source);await this.save(item);}
        item.state='submitting';item.submissionAttempted=true;await this.save(item);
        item.requestId=isTripo?await this.tripo!.submit(item.fileToken!,item.meta):(await this.bria!.imageForeground!((await readFile(source)).toString('base64'))).request_id;await this.save(item);
      }
      const alpha=this.store.path('images',id,'alpha.png');
      if(!item.artifactReady) {
        item.state='processing';await this.save(item);
        const until=Date.now()+this.timeout;
        for(;;) {
          if(Date.now()>until)throw new AppError('IMAGE_POLL_TIMEOUT','图片处理等待超时，可继续查询原任务。',504);
          const status=await gateway.status(item.requestId);
          item.providerStatus=status.status;item.lastCheckedAt=new Date().toISOString();await this.save(item);
          if(status.status==='ERROR')throw new AppError('IMAGE_UPSTREAM_FAILED','图片平台处理失败，请检查素材或账号服务。',422);
          if(status.status==='UNKNOWN')throw new AppError('IMAGE_STATUS_UNKNOWN','图片平台暂时无法确认任务状态，可稍后继续查询。',502);
          if(status.status==='COMPLETED') {
            if(!status.result?.image_url)throw new AppError('IMAGE_RESULT_MISSING','图片结果缺少文件地址。',502);
            item.state='downloading';await this.save(item);
            await gateway.download(status.result.image_url,alpha,RESULT_MAX_BYTES);
            // Validate the downloaded image now; whiteImage also checks alpha and geometry before export.
            await imageMeta(alpha);item.artifactReady=true;await this.save(item);break;
          }
          await delay(this.pollMs);
        }
      }
      item.state='composing';await this.save(item);
      item.outputMeta=await whiteImage(alpha,this.store.path('images',id,'white.png'),isTripo?undefined:item.meta);
      item.state='completed';delete item.error;item.canResume=false;await this.save(item);
    }catch(error) {
      if(item.state==='submitting'&&error instanceof BriaHttpError&&error.httpStatus>=400&&error.httpStatus<500&&error.httpStatus!==408)item.submissionAttempted=false;
      item.error=publicError(error);item.state='failed';
      item.canResume=!!item.artifactReady||!!item.requestId&&!['IMAGE_UPSTREAM_FAILED','BRIA_HTTP_404','TRIPO_HTTP_404'].includes(item.error.code)||!item.submissionAttempted;
      await this.save(item);
    }
  }
}

export function registerImageRoutes(app:FastifyInstance,engine:ImagePipeline) {
  app.post('/api/images',async(request,reply)=>{
    if(!(request.body instanceof Readable))throw new AppError('INVALID_IMAGE_UPLOAD','请以二进制流上传图片。',415);
    if(Number(request.headers['content-length'])>IMAGE_MAX_BYTES)throw new AppError('IMAGE_TOO_LARGE','图片不能超过 20 MiB。',413);
    const id=randomUUID(),folder=engine.store.path('images',id,'');await mkdir(folder,{recursive:true});
    const source=engine.store.path('images',id,'upload');let bytes=0;
    try {
      const limit=new Transform({transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;callback(bytes>IMAGE_MAX_BYTES?new AppError('IMAGE_TOO_LARGE','图片不能超过 20 MiB。',413):null,chunk);}});
      await streamPipeline(request.body,limit,createWriteStream(source,{mode:0o600}));
      const meta=await normalizeImage(source,engine.store.path('images',id,'source.png'));
      let filename=String(request.headers['x-video-filename']??'image.png');
      try{filename=decodeURIComponent(filename);}catch{filename='image.png';}
      filename=filename.replace(/[\\/\0-\x1f\x7f]/g,'_').slice(-160)||'image.png';
      const now=new Date().toISOString(),item:ImageRecord={id,filename,meta,state:'uploaded',createdAt:now,updatedAt:now};
      await rm(source,{force:true});await engine.store.save('image-jobs',item);
      return reply.code(201).send(imageView(item));
    }catch(error){await rm(folder,{recursive:true,force:true});throw error;}
  });
  app.get('/api/images',async()=> (await engine.store.list<ImageRecord>('image-jobs')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20).map(imageView));
  app.get<{Params:{id:string};Querystring:{provider?:string}}>('/api/images/:id',async request=>imageView(await engine.get(request.params.id,request.query.provider===undefined?undefined:providerName(request.query.provider))));
  app.post<{Params:{id:string}}>('/api/images/:id/process',async(request,reply)=>{
    const body=object(request.body??{});
    return reply.code(202).send(imageView(await engine.start(request.params.id,body.provider===undefined?undefined:providerName(body.provider))));
  });
  for(const variant of ['source','file'] as const)app.get<{Params:{id:string};Querystring:{download?:string}}>(`/api/images/:id/${variant}`,async(request,reply)=>{
    const item=await engine.store.get<ImageRecord>('image-jobs',validId(request.params.id));
    if(variant==='file'&&item.state!=='completed')throw new AppError('IMAGE_NOT_READY','图片尚未完成处理。',409);
    const file=engine.store.path('images',variant==='source'?(item.sourceId??item.id):item.id,variant==='source'?'source.png':'white.png');
    return reply.type('image/png').header('Content-Length',(await stat(file)).size)
      .header('Content-Disposition',`${request.query.download==='1'?'attachment':'inline'}; filename="${variant==='file'?'white':'source'}-${item.id.slice(0,8)}.png"`).send(createReadStream(file));
  });
}
