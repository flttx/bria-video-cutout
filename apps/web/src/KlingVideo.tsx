import { useEffect, useRef, useState } from 'react';
import { api, apiUrl, ApiError } from './api';
import PortraitVideo from './PortraitVideo';

interface VideoItem {id:string;state:string;videoUrl?:string;canResume:boolean;providerStatus?:string;lastCheckedAt?:string;error?:{code?:string;message:string};meta?:{width:number;height:number;duration:number}}
const labels:Record<string,string>={queued:'等待生成',whitening:'1/3 · Bria 正在生成白底图片',submitting:'2/3 · 正在提交可灵',processing:'2/3 · 可灵正在生成旋转视频',downloading:'3/3 · 正在保存并校验视频',completed:'视频已完成',failed:'视频生成未完成'};
const active=(item:VideoItem|null)=>!!item&&!['completed','failed'].includes(item.state);
interface Props {imageId?:string;imageReady:boolean;autoStart:boolean;blocked:boolean;enabled:boolean|undefined;briaEnabled:boolean;onActivity:(value:boolean)=>void}
export default function KlingVideo({imageId,imageReady,autoStart,blocked,enabled,briaEnabled,onActivity}:Props){
  const [item,setItem]=useState<VideoItem|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(!!imageId),[error,setError]=useState('');
  const locked=useRef(false),alive=useRef(true),autoStarted=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{onActivity(busy||active(item));return()=>onActivity(false);},[busy,item?.state,onActivity]);
  useEffect(()=>{
    if(!imageId||enabled===undefined){setLoading(false);return;}
    const controller=new AbortController();
    void api<VideoItem>(`/api/image-videos/${imageId}`,undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])).then(value=>{if(!controller.signal.aborted)setItem(value);}).catch(e=>{
      if(!controller.signal.aborted&&!(e instanceof ApiError&&e.status===404))setError('视频任务查询失败，可稍后重试；不会重复创建任务。');
    }).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[imageId,enabled]);
  useEffect(()=>{
    if(!active(item)||!imageId)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    async function poll(){
      try{const value=await api<VideoItem>(`/api/image-videos/${imageId}`,undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]));
        if(controller.signal.aborted)return;setItem(value);setError('');if(!active(value))return;
      }catch{if(!controller.signal.aborted)setError('视频状态查询中断，正在重连；服务端继续处理。');}
      if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),2000);
    }
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[imageId,item?.state]);
  useEffect(()=>{
    if(!autoStart||loading||item||!enabled||!imageId||blocked||autoStarted.current)return;
    autoStarted.current=true;void generate();
  },[autoStart,loading,item,enabled,imageId,blocked]);
  async function generate(){
    if(!imageId||locked.current||active(item))return;
    locked.current=true;setBusy(true);setError('');
    try{const value=await api<VideoItem>('/api/image-videos',{imageId},AbortSignal.timeout(20000));if(alive.current)setItem(value);}
    catch(e){
      if(!alive.current)return;
      try{const value=await api<VideoItem>(`/api/image-videos/${imageId}`,undefined,AbortSignal.timeout(10000));if(alive.current)setItem(value);}catch{/* Stable image ID deduplicates any subsequent request. */}
      if(alive.current)setError(e instanceof Error?e.message:'请求结果待确认，请恢复查询原任务。');
    }finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  const waiting=item?.state==='processing'&&item.providerStatus==='submitted';
  const uncertainWhite=item?.state==='failed'&&item.error?.code==='BRIA_WHITE_UNCERTAIN';
  const status=item?.state==='processing'?(waiting?'2/3 · 可灵平台排队中，等待开始生成':item.providerStatus==='processing'?labels.processing:'2/3 · 正在查询可灵任务状态'):
    uncertainWhite?'Bria 提交结果待核对，视频尚未开始生成':item?.state==='failed'&&item.canResume&&item.error?.code==='KLING_CONNECTION'?'可灵状态查询中断，请恢复查询原任务':item?labels[item.state]:'';
  return <section className="image-white-card kling-video" aria-label="可灵白底旋转视频">
    <h3>视频结果</h3>
    {item?.videoUrl?<PortraitVideo key={item.videoUrl} src={apiUrl(item.videoUrl)} label="可灵旋转视频"/>:<div className="portrait-video-stage"><p>{busy?'正在提交…':loading?'正在查询任务…':item?status:'上传图片后，在这里查看视频结果'}</p></div>}
    <div className="image-white-actions">
      {item?.videoUrl?<a className="primary-button" href={apiUrl(item.videoUrl)+'?download=1'} download>下载可灵 MP4</a>:
        <button className="primary-button" disabled={!enabled||!imageId||(!imageReady&&!briaEnabled)||blocked||busy||loading||active(item)||item?.state==='failed'&&!item.canResume} onClick={()=>void generate()}>{busy?'正在提交…':waiting?'平台排队中…':active(item)?'正在处理任务…':item?.state==='failed'?(item.canResume?'恢复视频任务':uncertainWhite?'等待核对提交结果':'任务已停止'):'生成白底旋转视频'}</button>}
    </div>
    {!enabled&&<p className="helper">{enabled===undefined?'当前服务未启用可灵视频，请更新服务端。':'可灵服务未配置，已有视频仍可播放和下载。'}</p>}
    <p className="helper" role="status">{loading?'正在查询视频任务…':item?status:autoStart?'正在准备生成视频…':'上传新图片后自动生成；历史任务只查询已有结果。'}</p>
    {item?.lastCheckedAt&&<p className="helper">最近确认平台状态：{new Date(item.lastCheckedAt).toLocaleString('zh-CN',{hour12:false})}</p>}
    {(error||item?.error)&&<p className="error-text" role="alert">{error||item?.error?.message}</p>}
    {item?.meta&&<p className="helper">{item.meta.width} × {item.meta.height} · {item.meta.duration} 秒</p>}
    <p className="helper">9:16 预览 · 可灵 3.0 · 1080p · 6 秒 · 无声。关闭页面后继续生成；刷新后从最近任务查看。AI 小角度左右轻转、主体细节与白底效果需检查。</p>
  </section>;
}
