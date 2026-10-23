export interface JobInput {
  id:string; videoId:string; mode:"auto"|"prompt"|"points"; prompt:string;
  points:{x:number;y:number;type:"positive"|"negative";atSeconds:number}[];
  start:number;end:number;reusable:boolean;color:string;resolution:string;
}
export interface Job {
  id:string;state:string;input:JobInput;exportId?:string;canResume:boolean;reusable:boolean;
  error?:{code:string;message:string};warning?:string;createdAt:string;
  sourceMeta?:{width:number;height:number;fps:number};
  latestExport?:ExportResult;
  latestAttempt?:ExportResult;
  filename?:string;videoDuration?:number;
}
export interface ExportResult {
  id:string;state:string;color:string;resolution:string;downloadUrl?:string;bytes?:number;
  meta?:{width:number;height:number;duration:number;fps:number;hasAudio:boolean};
  error?:{code:string;message:string};
}
export class ApiError extends Error {constructor(message:string,readonly status:number){super(message);}}
export async function api<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T> {
  const response=await fetch(path,{method:body===undefined?"GET":"POST",headers:body===undefined?{}:{"Content-Type":"application/json","X-Cutout-Client":"1"},body:body===undefined?undefined:JSON.stringify(body),signal});
  return parseResponse<T>(response);
}
export async function parseResponse<T>(response:Response):Promise<T> {
  const data:unknown=await response.json().catch(()=>null);
  if(!response.ok) {
    const message=data&&typeof data==="object"&&"message"in data&&typeof data.message==="string"?data.message:`本地请求失败（HTTP ${response.status}）。`;
    throw new ApiError(message,response.status);
  }
  return data as T;
}
