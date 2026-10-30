import { useEffect, useRef, useState } from 'react';
import { api, apiUrl, parseResponse, serverEnabled } from './api';
import KlingVideo from './KlingVideo';

interface ImageItem {
  id:string;filename:string;meta:{width:number;height:number};state:string;
  sourceId?:string;provider?:'bria'|'tripo';sourceUrl:string;
}
export default function ImageWhite(){
  const [item,setItem]=useState<ImageItem|null>(null),[history,setHistory]=useState<ImageItem[]>([]);
  const [busy,setBusy]=useState(false),[videoActive,setVideoActive]=useState(false),[autoStart,setAutoStart]=useState(false);
  const [klingEnabled,setKlingEnabled]=useState<boolean|undefined>(undefined),[briaEnabled,setBriaEnabled]=useState(false);
  const [serviceMessage,setServiceMessage]=useState('正在检查生成服务…'),[error,setError]=useState('');
  const input=useRef<HTMLInputElement>(null),locked=useRef(false),alive=useRef(true);
  const ready=briaEnabled&&klingEnabled,busyOrActive=busy||videoActive;
  useEffect(()=>{
    alive.current=true;
    if(!serverEnabled){setServiceMessage('图片白底视频需要服务器处理模式。');return;}
    const controller=new AbortController();
    void (async()=>{
      try{
        const health=await api<{imageWhiteEnabled?:boolean;imageWhiteProviders?:{bria:boolean};klingVideoEnabled?:boolean}>('/api/health',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]));
        if(controller.signal.aborted)return;
        const bria=health.imageWhiteProviders?.bria??!!health.imageWhiteEnabled;
        setBriaEnabled(bria);setKlingEnabled(health.klingVideoEnabled);
        setServiceMessage(bria&&health.klingVideoEnabled?'':'生成服务未就绪，请在服务端启用 Bria 图片接口和可灵；已有视频仍可查看。');
        if(health.imageWhiteEnabled!==undefined){
          const rows=await api<ImageItem[]>('/api/images',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]));
          if(!controller.signal.aborted)setHistory(rows.filter(row=>(row.provider??'bria')==='bria'&&(!row.sourceId||row.sourceId===row.id)));
        }
      }catch{if(!controller.signal.aborted)setServiceMessage('无法连接生成服务，请检查连接后重新打开此入口。');}
    })();
    return()=>{alive.current=false;controller.abort();};
  },[]);
  async function choose(file:File){
    if(locked.current||busyOrActive||!ready)return;
    setError('');
    if(!/\.(png|jpe?g)$/i.test(file.name)||!file.size||file.size>20*1024*1024){setError('请选择不超过 20 MiB 的 PNG 或 JPG 静态图片。');return;}
    locked.current=true;setBusy(true);
    try{
      const response=await fetch(apiUrl('/api/images'),{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/octet-stream','X-Cutout-Client':'1','X-Video-Filename':encodeURIComponent(file.name)},body:file,signal:AbortSignal.timeout(120000)});
      const uploaded=await parseResponse<ImageItem>(response);if(!alive.current)return;
      // Only a newly selected file authorizes auto-generation; history is always read-only.
      setAutoStart(true);setItem(uploaded);setHistory(rows=>[uploaded,...rows].slice(0,20));
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:'图片上传失败。');}
    finally{locked.current=false;if(alive.current)setBusy(false);}
  }
  return <section className="image-white image-video-workspace" aria-label="图片白底工作台">
    <div className="image-white-heading"><div><h2>图片白底</h2><p className="helper">上传图片，自动生成白底旋转视频。</p></div>
      <button className="outline-button" disabled={!ready||busyOrActive} onClick={()=>input.current?.click()}>{item?'更换图片并生成':'选择图片并生成'}</button>
    </div>
    {!ready&&<p className="helper" role="status">{serviceMessage}</p>}
    <p className="helper">上传后即开始生成并使用 Bria 和可灵额度。主体请完整居中；PNG / JPG，最大 20 MiB，宽高至少 300px。</p>
    <input ref={input} hidden type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" aria-label="选择图片文件" disabled={!ready||busyOrActive} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void choose(file);}}/>
    {error&&<p className="error-text" role="alert">{error}</p>}
    <div className="image-white-previews">
      <section className="image-white-card"><h3>原图</h3><div className="image-white-stage image-white-source">
        {item?<img src={apiUrl(item.sourceUrl)} alt="待处理原图"/>:<button className="image-white-drop" disabled={!ready||busyOrActive} onClick={()=>input.current?.click()}><strong>上传图片生成视频</strong><span>PNG / JPG · 最大 20 MiB</span></button>}
      </div><p className="helper">{busy?'正在上传图片…':item?`${item.filename} · ${item.meta.width} × ${item.meta.height}`:'建议使用 9:16 竖图，主体四周保留空间。'}</p></section>
      <KlingVideo key={item?.id??'empty'} imageId={item?.id} imageReady={item?.state==='completed'} autoStart={autoStart} blocked={busy} enabled={klingEnabled} briaEnabled={briaEnabled} onActivity={setVideoActive}/>
    </div>
    {!!history.length&&<details className="image-white-history"><summary>最近任务（{history.length}）</summary><ul>
      {history.map(row=><li key={row.id}><button className="outline-button" disabled={busyOrActive} onClick={()=>{setAutoStart(false);setItem(row);setError('');}}><span>{row.filename}</span><small>查看视频任务</small></button></li>)}
    </ul></details>}
  </section>;
}
