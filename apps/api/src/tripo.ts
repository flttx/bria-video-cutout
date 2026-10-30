import { openAsBlob } from 'node:fs';
import { downloadFile } from './bria/client.js';
import { AppError } from './errors.js';

export type TripoRegion='china'|'global';
export type TripoImageGateway=Pick<TripoClient,'region'|'upload'|'submit'|'status'|'download'>;
const badResponse=()=>new AppError('TRIPO_RESPONSE','Tripo 返回格式无法确认，请核对原任务；不会自动重新提交。',502);
function record(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw badResponse();
  return value as Record<string,unknown>;
}
function identifier(value:unknown):string {
  if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,200}$/.test(value))throw badResponse();
  return value;
}
export class TripoClient {
  private readonly base:string;
  constructor(private readonly key:string,readonly region:TripoRegion='china',private readonly transport:typeof fetch=fetch) {
    this.base=`https://openapi.tripo3d.${region==='china'?'com':'ai'}/v3`;
  }
  private async request(path:string,body?:FormData|Record<string,unknown>) {
    try {
      const response=await this.transport(this.base+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(120000),
        headers:{Authorization:`Bearer ${this.key}`,...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},
        body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
      // No automatic submission retry, including HTTP errors: delivery/billing may be ambiguous.
      if(!response.ok)throw new AppError(`TRIPO_HTTP_${response.status}`,`Tripo 请求失败（HTTP ${response.status}），请核对账号与原任务。`,502);
      const result=record(await response.json());
      if(result.code!==0)throw new AppError('TRIPO_REJECTED','Tripo 未返回成功结果，请核对账号与原任务。',502);
      return record(result.data);
    }catch(error) {
      if(error instanceof AppError)throw error;
      throw new AppError('TRIPO_CONNECTION','Tripo 连接中断或响应无效，请核对原任务；不会自动重新提交。',502);
    }
  }
  async upload(file:string) {
    const form=new FormData();form.append('file',await openAsBlob(file,{type:'image/png'}),'source.png');
    return identifier((await this.request('/files',form)).file_token);
  }
  async submit(input:string,meta:{width:number;height:number}) {
    // seedream explicit size: ~4.2 MP, preserving source aspect ratio to pixel rounding.
    const scale=Math.sqrt(4_194_304/(meta.width*meta.height));
    const size=`${Math.round(meta.width*scale)}x${Math.round(meta.height*scale)}`;
    return identifier((await this.request('/generation/image-to-image',{model:'seedream_v5',input,size,output_format:'png',
      prompt:'Replace only the background with uniform pure white (#FFFFFF). Preserve the entire original subject, identity, shape, materials, colors, fine details, text and pose. Keep the same composition and aspect ratio. Do not crop, add objects, shadows, gradients or decorations.'})).task_id);
  }
  async status(id:string) {
    const data=await this.request(`/tasks/${identifier(id)}`);
    if(data.task_id!==id)throw badResponse();
    if(['failed','cancelled','banned','expired'].includes(String(data.status)))return {status:'ERROR' as const};
    if(['queued','running'].includes(String(data.status)))return {status:'IN_PROGRESS' as const};
    if(data.status!=='success')return {status:'UNKNOWN' as const};
    const url=record(data.output).generated_image_url;
    if(typeof url!=='string')throw badResponse();
    return {status:'COMPLETED' as const,result:{image_url:url}};
  }
  async download(url:string,file:string,maxBytes:number) {
    try {await downloadFile(url,file,this.transport,maxBytes);}
    catch {throw new AppError('TRIPO_DOWNLOAD','Tripo 结果下载或安全校验失败，可恢复查询原任务。',502);}
  }
}
export function tripoSettings(env:NodeJS.ProcessEnv):TripoClient|undefined {
  const key=env.TRIPO_API_KEY?.trim();if(!key)return;
  const region=env.TRIPO_API_REGION?.trim()||'china';
  if(region!=='china'&&region!=='global')throw new AppError('TRIPO_CONFIG','TRIPO_API_REGION 仅支持 china 或 global。');
  return new TripoClient(key,region);
}
