import { readFile } from 'node:fs/promises';
import { downloadFile } from './bria/client.js';
import { AppError } from './errors.js';

export type KlingRegion='china'|'global';
export const KLING_MODEL='kling-3.0';
export const KLING_DURATION=6;
export const KLING_PROMPT="One uninterrupted six-second view of only the reference subject against a pure white (#FFFFFF) background, with a fixed camera. Treat the subject as a completely rigid, inanimate display object. Lock its exact reference pose: the relative positions, distances and angles of every part must remain unchanged throughout. No articulation or independent motion of any part; no walking, gestures, expression changes, breathing, bending, stretching or secondary motion. The only movement is rotation of the entire object together around one fixed vertical axis through its center. Follow this gentle sequence: start at the reference orientation; slowly rotate the whole object about 15 degrees to the viewer's left by 2 seconds; smoothly return to the original reference orientation by 4 seconds; then slowly rotate the whole object about 15 degrees to the viewer's right by 6 seconds. Ease smoothly at the change of direction, without shaking, wobbling or sudden acceleration. Keep the reference-facing surfaces visible; do not reveal the rear or make large turns. Preserve the original shape, proportions, colors, materials, labels and surface details. Keep the entire subject centered, at constant size, fully inside the frame with safe margins, without translation, tilting, morphing, flicker, cuts or jumps. Keep the space around and below it empty white. Do not add any pedestal, base, platform, rotating disk, display stand, table, floor, support, scenery, props, text overlays or other objects absent from the reference. Maintain consistent neutral lighting and a uniform white background, without gradients, horizon lines, zoom, pan or tilt.";
export interface KlingTask {id:string;status:'submitted'|'processing'|'succeeded'|'failed';url?:string}
export type KlingGateway=Pick<KlingClient,'region'|'submit'|'query'|'download'>;
const invalid=()=>new AppError('KLING_RESPONSE','可灵响应无法确认，请恢复查询原任务；不会自动再次生成。',502);
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();return value as Record<string,unknown>;}
function identifier(value:unknown):string{if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,200}$/.test(value))throw invalid();return value;}
export class KlingClient {
  private readonly base:string;
  constructor(private readonly key:string,readonly region:KlingRegion='china',private readonly transport:typeof fetch=fetch){
    this.base=`https://api-${region==='china'?'beijing':'singapore'}.klingai.com`;
  }
  private async request(path:string,body?:Record<string,unknown>):Promise<unknown>{
    try{
      const response=await this.transport(this.base+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(120000),
        headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
      if(!response.ok)throw new AppError(`KLING_HTTP_${response.status}`,`可灵请求失败（HTTP ${response.status}），请检查服务端账号配置并恢复查询原任务。`,502);
      const result=record(await response.json());
      if(result.code!==0)throw new AppError('KLING_REJECTED','可灵未返回成功结果，请核对账号权限、额度与原任务。',502);
      return result.data;
    }catch(error){if(error instanceof AppError)throw error;throw new AppError('KLING_CONNECTION','可灵连接中断，请恢复查询原任务；不会自动再次生成。',502);}
  }
  async submit(file:string,externalId:string){
    const image=await readFile(file);
    if(image.length>50_000_000)throw new AppError('KLING_IMAGE_SIZE','可灵输入图片不能超过 50 MB。',413);
    // Server-to-server Base64: private/local images never require a public URL.
    const data=record(await this.request(`/image-to-video/${KLING_MODEL}`,{
      contents:[{type:'prompt',text:KLING_PROMPT},{type:'first_frame',url:image.toString('base64')}],
      settings:{resolution:'1080p',duration:KLING_DURATION,audio:'off',multi_shot:false},
      options:{external_task_id:identifier(externalId),watermark_info:{enabled:false}},
    }));
    return identifier(data.id);
  }
  async query(value:string,external=false):Promise<KlingTask|undefined>{
    const rows=await this.request(`/tasks?${external?'external_task_ids':'task_ids'}=${identifier(value)}`);
    if(!Array.isArray(rows))throw invalid();
    if(!rows.length&&external)return;
    if(rows.length!==1)throw invalid();
    const row=record(rows[0]);
    if(row[external?'external_id':'id']!==value)throw invalid();
    const id=identifier(row.id),status=row.status;
    if(status!=='submitted'&&status!=='processing'&&status!=='succeeded'&&status!=='failed')throw invalid();
    if(status!=='succeeded')return {id,status};
    if(!Array.isArray(row.outputs))throw invalid();
    const output=row.outputs.map(record).find(item=>item.type==='video');
    if(typeof output?.url!=='string')throw invalid();
    return {id,status,url:output.url};
  }
  async download(url:string,file:string,maxBytes:number){
    try{await downloadFile(url,file,this.transport,maxBytes);}
    catch{throw new AppError('KLING_DOWNLOAD','可灵视频下载失败，可恢复查询原任务。',502);}
  }
}
export function klingSettings(env:NodeJS.ProcessEnv):KlingClient|undefined{
  const key=env.KLING_API_KEY?.trim();if(!key)return;
  const region=env.KLING_API_REGION?.trim()||'china';
  if(region!=='china'&&region!=='global')throw new AppError('KLING_CONFIG','KLING_API_REGION 仅支持 china 或 global。');
  if(/[\r\n\x00]/.test(key))throw new AppError('KLING_CONFIG','可灵密钥格式无效。');
  return new KlingClient(key,region);
}
