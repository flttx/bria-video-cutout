import type { VideoRecord } from '../../api/src/model';
export const serverEnabled=import.meta.env.MODE==='server';
export function apiUrl(path:string):string;
export function apiUrl(path:string|undefined):string|undefined;
export function apiUrl(path:string|undefined) {
  // Preserve blob URLs in browser mode and already-prefixed links from newer servers.
  return serverEnabled&&path?.startsWith('/api/')?`/bria-cutout${path}`:path;
}
export async function importVideo(file:File,progress:(percent:number)=>void=()=>{}):Promise<VideoRecord> {
  if(!serverEnabled)return (await import('./browser/pipeline')).importVideo(file,progress);
  if(!file.size||file.size>1_000_000_000)throw new ApiError('文件须大于 0 字节且不超过 1 GB。',413);
  progress(0);
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open('POST',apiUrl('/api/videos'));xhr.timeout=600000;
    xhr.setRequestHeader('Content-Type','application/octet-stream');
    xhr.setRequestHeader('X-Cutout-Client','1');
    xhr.setRequestHeader('X-Video-Filename',encodeURIComponent(file.name));
    xhr.upload.onprogress=event=>{if(event.lengthComputable)progress(Math.min(99,Math.round(event.loaded/event.total*100)));};
    xhr.onerror=xhr.ontimeout=xhr.onabort=()=>reject(new ApiError('上传中断，请检查服务器连接后重试。',0));
    xhr.onload=()=>{
      void parseResponse<VideoRecord>(new Response(xhr.responseText,{status:xhr.status})).then(record=>{progress(100);resolve(record);},reject);
    };
    xhr.send(file);
  });
}
export async function previewVideo(id:string) {
  if(!serverEnabled)return (await import('./browser/pipeline')).previewVideo(id);
  await api(`/api/videos/${encodeURIComponent(id)}/preview`,{});
  return apiUrl(`/api/videos/${encodeURIComponent(id)}/preview`);
}
export interface JobInput {
  id:string; videoId:string; mode:"auto"|"prompt"|"points"; prompt:string;
  points:{x:number;y:number;type:"positive"|"negative";atSeconds:number}[];
  start:number;end:number;reusable:boolean;color:string;resolution:string;framing?:"subject"|"original";
}
export interface Job {
  id:string;state:string;input:JobInput;exportId?:string;canResume:boolean;reusable:boolean;
  error?:{code:string;message:string};warning?:string;createdAt:string;
  sourceMeta?:{width:number;height:number;fps:number};
  latestExport?:ExportResult;
  latestAttempt?:ExportResult;
  thumbnailUrl?:string;
  filename?:string;videoDuration?:number;
}
export interface ExportResult {
  id:string;state:string;color:string;resolution:string;framing?:"subject";downloadUrl?:string;bytes?:number;
  meta?:{width:number;height:number;duration:number;fps:number;hasAudio:boolean};
  error?:{code:string;message:string};
}
export class ApiError extends Error {constructor(message:string,readonly status:number){super(message);}}
export async function api<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T> {
  if(serverEnabled)return parseResponse<T>(await fetch(apiUrl(path),{method:body===undefined?'GET':'POST',credentials:'same-origin',redirect:'error',headers:body===undefined?{}:{'Content-Type':'application/json','X-Cutout-Client':'1'},body:body===undefined?undefined:JSON.stringify(body),signal:signal??AbortSignal.timeout(600000)}));
  try{return await (await import('./browser/pipeline')).browserApi(path,body,signal) as T;}catch(error){if(error instanceof Error && 'statusCode' in error)throw new ApiError(error.message,Number(error.statusCode));throw error;}
}
export async function parseResponse<T>(response:Response):Promise<T> {
  const data:unknown=await response.json().catch(()=>null);
  if(!response.ok) {
    const message=data&&typeof data==="object"&&"message"in data&&typeof data.message==="string"?data.message:`请求失败（HTTP ${response.status}）。`;
    throw new ApiError(message,response.status);
  }
  return data as T;
}
