import { AppError, object, publicError } from '../../../api/src/errors.js';
import { validId, parseJob, exportOptions, MAX_BYTES } from '../../../api/src/model.js';
import type { JobRecord, ExportRecord, VideoRecord, VideoMeta } from '../../../api/src/model.js';
import type { CloudJobInput } from '../../../api/src/bria/cloud-contract.js';
import * as store from './store';
import * as media from './media';

interface BrowserJob extends JobRecord { owner?:string; rejected?:boolean }
interface CloudView {id:string;state:string;warning?:boolean;resultAvailable?:boolean;httpStatus?:number}
const active=new Set<string>();
let owner:string|undefined;
async function response<T>(result:Response):Promise<T> {
  const data=await result.json().catch(()=>null);
  if(!result.ok||!data)throw new AppError(data?.code??'CLOUD_NETWORK',data?.message??'云端请求失败，请检查网络或重新登录。',result.ok?502:result.status);
  return data as T;
}
async function cloud<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T> {
  try{return await response<T>(await fetch('/browser'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Cutout-Client':'1'},credentials:'same-origin',redirect:'error',body:body===undefined?undefined:JSON.stringify(body),signal:signal??AbortSignal.timeout(200000)}));}
  catch(error){if(error instanceof AppError)throw error;throw new AppError('CLOUD_NETWORK','云端连接中断，请检查网络或重新登录；不会自动重发抠图。',503);}
}
async function identify() {
  const health=await cloud<{userId:string;processingReady:boolean}>('/health');
  owner=health.userId;if(!health.processingReady)throw new AppError('CLOUD_CONFIG','抠图服务尚未配置完成。',503);return owner;
}
export async function importVideo(file:File,progress:(percent:number)=>void=()=>{}) {
  if(!file.size||file.size>MAX_BYTES)throw new AppError('UPLOAD_SIZE','文件须大于 0 字节且不超过 1 GB。',413);
  progress(0);
  const meta=await media.mediaSession(async()=>{await media.writeBlob('input',file);return media.probe('input');});
  const record:VideoRecord={id:crypto.randomUUID(),meta,bytes:file.size,filename:file.name,createdAt:new Date().toISOString()};
  await store.put('blob/video/'+record.id,file);await store.put('video/'+record.id,record);progress(100);
  return record;
}
export async function previewVideo(id:string) {
  validId(id);
  const record=await store.get<VideoRecord>('video/'+id),file=await store.get<Blob>('blob/video/'+id);
  const preview=await media.mediaSession(async()=>{await media.writeBlob('input',file);await media.compatiblePreview('input','preview.mp4',record.meta);return media.readBlob('preview.mp4');});
  await store.put('blob/preview/'+id,preview);return store.blobUrl('blob/preview/'+id);
}
async function exportView(item:ExportRecord) {
  return {...item,downloadUrl:item.state==='completed'?await store.blobUrl('blob/export/'+item.id):undefined};
}
async function jobView(job:BrowserJob) {
  const video=await store.get<VideoRecord>('video/'+job.input.videoId);
  const exports=(await store.list<ExportRecord>('export/')).filter(item=>item.jobId===job.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const last=exports.find(item=>item.state==='completed');
  let thumbnailUrl:string|undefined;try{thumbnailUrl=await store.blobUrl('blob/thumbnail/'+(last?.id??job.id));}catch{/* optional thumbnail */}
  return {...job,input:{...job.input,id:job.id},reusable:job.artifact!=='direct',filename:video.filename,videoDuration:video.meta.duration,thumbnailUrl,latestAttempt:exports[0]?await exportView(exports[0]):undefined,latestExport:last?await exportView(last):undefined};
}
async function save(job:BrowserJob) {job.updatedAt=new Date().toISOString();await store.put('job/'+job.id,job);}
async function state(job:BrowserJob,value:JobRecord['state']) {job.state=value;await save(job);}
function enqueue(key:string,work:()=>Promise<void>) {
  if(active.has(key))return;active.add(key);
  void navigator.locks.request('bria-'+key,{ifAvailable:true},async lock=>{if(lock)await work();}).catch(()=>{/* Persisted records remain available for recovery after storage failure. */}).finally(()=>active.delete(key));
}
async function upload(blob:Blob) {
  if(blob.size>MAX_BYTES)throw new AppError('UPLOAD_SIZE','预处理文件超过 1 GB，请裁短后重试。',413);
  const {uploadId,chunkSize}=await cloud<{uploadId:string;chunkSize:number}>('/uploads',{size:blob.size,mediaType:blob.type||'video/mp4'});
  if(chunkSize!==8*1024*1024)throw new AppError('CLOUD_RESPONSE','云端分片配置无效。',502);
  for(let start=0,part=1;start<blob.size;start+=chunkSize,part++) {
    await response(await fetch(`/browser/uploads/${uploadId}/parts/${part}`,{method:'PUT',headers:{'X-Cutout-Client':'1','Content-Type':'application/octet-stream'},body:blob.slice(start,start+chunkSize),redirect:'error',signal:AbortSignal.timeout(120000)}));
  }
  await cloud('/uploads/'+uploadId+'/complete',{});return uploadId;
}
async function thumbnail(blob:Blob):Promise<Blob|undefined> {
  const url=URL.createObjectURL(blob),video=document.createElement('video');
  video.muted=true;video.preload='auto';video.src=url;
  try {
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('thumbnail timeout')),10000);
      video.onloadeddata=()=>{clearTimeout(timer);resolve();};video.onerror=()=>{clearTimeout(timer);reject(new Error('thumbnail decode'));};
    });
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    const ctx=canvas.getContext('2d');if(!ctx)return;
    const scale=Math.min(320/video.videoWidth,180/video.videoHeight),width=video.videoWidth*scale,height=video.videoHeight*scale;
    ctx.fillStyle='#141412';ctx.fillRect(0,0,320,180);ctx.drawImage(video,(320-width)/2,(180-height)/2,width,height);
    return (await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',.8)))??undefined;
  }catch{return undefined;}finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
}
async function renderExport(item:ExportRecord) {
  try {
    const job=await store.get<BrowserJob>('job/'+item.jobId);
    if(!job.artifactReady||!job.sourceMeta||!job.artifact)throw new AppError('NOT_READY','抠图缓存尚不可用。',409);
    const source=await store.get<Blob>('blob/source/'+job.id),artifact=await store.get<Blob>('blob/artifact/'+job.id);
    item.state='exporting';delete item.error;await store.put('export/'+item.id,item);
    const result=await media.mediaSession(async()=>{
      await media.writeBlob('source.mp4',source);await media.writeBlob('artifact',artifact);
      const result=await media.render('source.mp4','artifact',job.artifact!,'output.mp4',item,job.sourceMeta!);
      const blob=await media.readBlob('output.mp4');
      return {...result,blob};
    });
    await store.put('blob/export/'+item.id,result.blob);
    const preview=await thumbnail(result.blob);if(preview)await store.put('blob/thumbnail/'+item.id,preview);
    Object.assign(item,{meta:result.meta,bytes:result.bytes,route:result.route,state:'completed'});await store.put('export/'+item.id,item);
  }catch(error){item.state='failed';item.error=publicError(error);await store.put('export/'+item.id,item);throw error;}
}
async function run(id:string) {
  const job=await store.get<BrowserJob>('job/'+id);
  if(job.state==='completed')return;
  try {
    if(!job.artifactReady) {
      if(await identify()!==job.owner)throw new AppError('ACCOUNT_MISMATCH','请使用创建此任务的账号登录。',403);
      if(!job.submissionAttempted) {
        const video=await store.get<VideoRecord>('video/'+job.input.videoId),file=await store.get<Blob>('blob/video/'+video.id);
        if(job.input.mode==='auto'&&job.input.start===0&&job.input.end===video.meta.duration&&video.meta.containerDuration===undefined) {
          // Older local records lack upload metadata; probe once instead of forcing a transcode.
          video.meta=await media.mediaSession(async()=>{await media.writeBlob('input',file);return media.probe('input');});
          await store.put('video/'+video.id,video);
        }
        // Whole-video auto jobs retain the original bytes. Include the container duration so
        // a longer audio track cannot turn a nominally valid selection into an over-limit upload.
        const original=job.input.mode==='auto'&&job.input.start===0&&job.input.end===video.meta.duration&&
          !!video.meta.uploadMediaType&&video.meta.containerDuration!==undefined&&Math.max(video.meta.duration,video.meta.containerDuration)<=60;
        await state(job,original?'uploading':'preparing');
        const prepared=original?{meta:video.meta,source:file,proxyMeta:video.meta,transfer:file.slice(0,file.size,video.meta.uploadMediaType)}:await media.mediaSession(async()=>{
          await media.writeBlob('input',file);const meta=await media.prepare('input','source.mp4',job.input,video.meta);
          const source=await media.readBlob('source.mp4');let proxyMeta=meta,transfer=source;
          if(job.input.mode!=='auto'){proxyMeta=await media.proxy('source.mp4','proxy.mp4');transfer=await media.readBlob('proxy.mp4');}
          return {meta,source,proxyMeta,transfer};
        });
        job.sourceMeta=prepared.meta;job.artifact=job.input.mode!=='auto'?'mask':job.input.reusable?'alpha':'direct';
        await store.put('blob/source/'+id,prepared.source);await state(job,'uploading');
        const uploadId=await upload(prepared.transfer);
        job.cloudJobId??=crypto.randomUUID();
        const m=prepared.proxyMeta;
        const input:CloudJobInput={cloudJobId:job.cloudJobId,uploadId,mode:job.input.mode,meta:{width:m.width,height:m.height,duration:m.duration,fps:m.fps,frames:m.frames}};
        if(job.input.mode==='auto'&&!job.input.reusable)input.color=job.input.color;
        if(job.input.mode==='prompt')input.prompt=job.input.prompt;
        if(job.input.mode==='points') {
          input.frame_index=Math.min(m.frames-1,Math.max(0,Math.floor((job.input.points[0]!.atSeconds-job.input.start)*m.fps)));
          input.key_points=job.input.points.map(p=>({x:Math.min(m.width-1,Math.floor(p.x*m.width)),y:Math.min(m.height-1,Math.floor(p.y*m.height)),type:p.type}));
        }
        job.submissionAttempted=true;await state(job,'submitting');
        await cloud('/jobs',input);
      }
      if(!job.cloudJobId)throw new AppError('SUBMISSION_UNCERTAIN','缺少原任务标识，请核对云端记录，不会重新提交。',409);
      await state(job,'processing');
      const deadline=Date.now()+1800000;let result:CloudView;
      while(true) {
        result=await cloud<CloudView>('/jobs/'+job.cloudJobId);
        if(result.state==='completed')break;
        if(result.state==='rejected'){job.rejected=true;throw new AppError('SUBMISSION_REJECTED',`Bria 拒绝了提交（HTTP ${result.httpStatus??'未知'}），修正配置后可主动恢复。`,502);}
        if(result.state==='uncertain')throw new AppError('SUBMISSION_UNCERTAIN','提交结果不明，请核对 Bria 控制台；不会再次提交。',409);
        if(result.state==='failed')throw new AppError('BRIA_TERMINAL','Bria 处理失败或任务已失效。',502);
        if(Date.now()>deadline)throw new AppError('POLL_TIMEOUT','等待超时，可恢复查询原任务。',504);
        await new Promise(resolve=>setTimeout(resolve,5000));
      }
      if(result.warning){job.warning='Bria 返回输出警告，请核对成片。';if(job.artifact==='alpha')throw new AppError('ALPHA_WARNING','Bria 返回透明输出警告，已停止导出。',422);}
      await state(job,'downloading');
      const downloaded=await fetch('/browser/jobs/'+job.cloudJobId+'/artifact',{redirect:'error',signal:AbortSignal.timeout(240000)});
      if(!downloaded.ok)await response(downloaded);
      const artifact=await downloaded.blob();
      await media.mediaSession(async()=>{await media.writeBlob('artifact',artifact);await media.validateArtifact('artifact',job.sourceMeta!,job.artifact!);});
      await store.put('blob/artifact/'+id,artifact);job.artifactReady=true;await save(job);
    }
    job.exportId=id;const item:ExportRecord={id,jobId:id,color:job.input.color,resolution:'source',state:'queued',createdAt:new Date().toISOString()};
    await store.put('export/'+id,item);await state(job,'exporting');await renderExport(item);
    delete job.error;job.canResume=false;await state(job,'completed');
  }catch(error){job.error=publicError(error);job.canResume=!['SUBMISSION_UNCERTAIN','BRIA_TERMINAL','RESULT_EXPIRED','ALPHA_WARNING'].includes(job.error.code);await state(job,'failed');}
}
export async function browserApi(path:string,body?:unknown,signal?:AbortSignal):Promise<unknown> {
  if(path==='/api/health') {
    if(!('locks' in navigator)||!('indexedDB' in window))throw new AppError('BROWSER_UNSUPPORTED','请使用支持浏览器存储和 Web Locks 的现代浏览器。',503);
    try{const data=await cloud<{userId:string;processingReady:boolean}>('/health',undefined,signal);owner=data.userId;return {...data,ok:true,tokenConfigured:data.processingReady};}
    catch(error){return {ok:true,processingReady:false,tokenConfigured:false,message:error instanceof Error?error.message:'云端暂不可用。'};}
  }
  if(path==='/api/jobs'&&body===undefined) {
    const jobs=(await store.list<BrowserJob>('job/')).filter(j=>!j.removedAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50);
    for(const job of jobs)if(!['completed','failed'].includes(job.state))enqueue('job:'+job.id,()=>run(job.id));
    for(const item of await store.list<ExportRecord>('export/'))if(['queued','exporting'].includes(item.state)) {
      const job=await store.get<BrowserJob>('job/'+item.jobId);
      if(job.state==='completed')enqueue('export:'+item.id,()=>renderExport(item));
    }
    return Promise.all(jobs.map(jobView));
  }
  if(path==='/api/jobs'&&body!==undefined) {
    const value=object(body),id=validId(value.id),video=await store.get<VideoRecord>('video/'+validId(value.videoId)),input=parseJob(body,video.meta);
    try{const job=await store.get<BrowserJob>('job/'+id);if(JSON.stringify(job.input)!==JSON.stringify(input))throw new AppError('ID_CONFLICT','此任务标识已使用。',409);return jobView(job);}catch(error){if(!(error instanceof AppError)||error.code!=='NOT_FOUND')throw error;}
    const user=await identify(),now=new Date().toISOString();
    const job:BrowserJob={id,input,owner:user,state:'queued',createdAt:now,updatedAt:now,transport:'cloud'};
    await store.put('job/'+id,job,true);enqueue('job:'+id,()=>run(id));return jobView(job);
  }
  const video=path.match(/^\/api\/videos\/([^/]+)$/);if(video)return store.get('video/'+validId(video[1]));
  const exported=path.match(/^\/api\/exports\/([^/]+)$/);if(exported)return exportView(await store.get('export/'+validId(exported[1])));
  const match=path.match(/^\/api\/jobs\/([^/]+)(?:\/(resume|export|remove|undo-remove))?$/);
  if(match) {
    const id=validId(match[1]),job=await store.get<BrowserJob>('job/'+id);
    if(!match[2])return jobView(job);
    if(body===undefined)throw new AppError('METHOD','此操作需要提交请求。',405);
    if(match[2]==='resume') {
      if(job.state!=='failed'||!job.canResume)throw new AppError('NOT_RESUMABLE','此任务不可恢复。',409);
      if(job.rejected){job.submissionAttempted=false;delete job.cloudJobId;delete job.rejected;}
      delete job.error;delete job.removedAt;await state(job,'queued');enqueue('job:'+id,()=>run(id));return jobView(job);
    }
    if(match[2]==='export') {
      const value=object(body),options=exportOptions(body),exportId=validId(value.id);
      if(job.state!=='completed'||!job.artifactReady)throw new AppError('NOT_READY','任务尚未完成。',409);
      if(job.artifact==='direct'&&options.color!==job.input.color)throw new AppError('NO_ALPHA','此结果没有透明缓存，换色需重新抠图。',409);
      const item:ExportRecord={...options,id:exportId,jobId:id,state:'queued',createdAt:new Date().toISOString()};
      await store.put('export/'+exportId,item,true);delete job.removedAt;await save(job);enqueue('export:'+exportId,()=>renderExport(item));return exportView(item);
    }
    if(!['completed','failed'].includes(job.state)||(await store.list<ExportRecord>('export/')).some(e=>e.jobId===id&&['queued','exporting'].includes(e.state)))throw new AppError('TASK_ACTIVE','处理结束后才能移除记录。',409);
    if(match[2]==='remove')job.removedAt=new Date().toISOString();else delete job.removedAt;
    await save(job);return {ok:true};
  }
  throw new AppError('NOT_IMPLEMENTED','此操作尚未实现。',501);
}
