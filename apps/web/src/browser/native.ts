import { AppError } from '../../../api/src/errors.js';
import type { ExportOptions, ExportRecord, VideoMeta } from '../../../api/src/model.js';

export const nativeEnabled=import.meta.env.DEV&&import.meta.env.MODE==='native';
async function failure(response:Response):Promise<never> {
  const error=await response.json().catch(()=>null);
  throw new AppError(typeof error?.code==='string'?error.code:'NATIVE_RESPONSE',typeof error?.message==='string'?error.message:'本机合成服务响应异常，请检查服务后恢复任务。',response.status);
}
export async function nativeHealth() {
  try {
    const response=await fetch('/native/health',{headers:{'X-Cutout-Client':'1'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)await failure(response);
    const health=await response.json();
    if(health.service!=='cutout-native'||health.version!==1)throw new Error('version');
  }catch(error){if(error instanceof AppError)throw error;throw new AppError('NATIVE_UNAVAILABLE','本机 FFmpeg 服务未连接，请启动 npm run dev:native 后恢复任务。',503);}
}
export async function nativeRender(source:Blob,artifact:Blob,kind:'alpha'|'mask'|'direct',options:ExportOptions) {
  await nativeHealth();
  let response:Response;
  try {
    response=await fetch('/native/render',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Cutout-Client':'1','X-Cutout-Render':JSON.stringify({sourceBytes:source.size,kind,color:options.color,resolution:'source'})},body:new Blob([source,artifact]),signal:AbortSignal.timeout(1_860_000)});
  }catch{throw new AppError('NATIVE_INTERRUPTED','本机合成连接中断，请恢复任务重试本地导出；不会重新提交 Bria。',503);}
  if(!response.ok)await failure(response);
  const result=JSON.parse(response.headers.get('X-Cutout-Result')??'null') as {meta:VideoMeta;bytes:number;route:ExportRecord['route']}|null;
  if(!result?.meta||!result.bytes)throw new AppError('NATIVE_RESPONSE','本机合成结果缺少校验信息。',502);
  const blob=await response.blob();
  if(blob.size!==result.bytes)throw new AppError('NATIVE_INCOMPLETE','本机成片传输不完整，请恢复导出。',502);
  return {...result,blob};
}
