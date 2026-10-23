import { useEffect, useRef, useState } from "react";
import { api, ApiError, parseResponse } from "./api";
import useBackendHealth from "./useBackendHealth";
import type { ExportResult, Job, JobInput } from "./api";

interface Props {
  file:File|null;videoId:string|null;videoReady:boolean;duration:number;mode:JobInput["mode"];prompt:string;points:JobInput["points"];
  color:string;onBusy:(busy:boolean)=>void;onResultSettled:()=>void;
  view:"source"|"result";onEditSource:()=>void;colorLabel:(name:string)=>string;
}
const LABELS:Record<string,string>={queued:"等待本地队列",preparing:"裁剪与准备视频",uploading:"上传视频到 Bria",submitting:"提交 Bria 任务",processing:"Bria 正在处理",downloading:"下载抠图结果",exporting:"本地合成与编码",completed:"处理完成",failed:"处理失败"};
const MODE_LABELS:Record<JobInput["mode"],string>={auto:"自动识别",prompt:"文字描述",points:"点选目标"};
const STEPS=[{label:"准备素材",states:["local-upload","queued","preparing"]},{label:"提交抠图",states:["uploading","submitting"]},{label:"处理视频",states:["processing"]},{label:"导出成品",states:["downloading","exporting"]}];
function TaskSteps({state}:{state:string}) {
  const current=STEPS.findIndex(step=>step.states.includes(state));
  return <ol className="task-steps" aria-label="处理步骤">{STEPS.map((step,index)=><li key={step.label} className={index===current?"current":index<current?"done":""} aria-current={index===current?"step":undefined}><span aria-hidden="true">{index+1}</span>{step.label}</li>)}</ol>;
}
const PENDING_JOB="bria-cutout.pending-job";
const isActive=(state:string)=>state!=="completed"&&state!=="failed";
function readStored(key:string) {try{return localStorage.getItem(key);}catch{return null;}}
function store(key:string,value:string|null) {try{value===null?localStorage.removeItem(key):localStorage.setItem(key,value);}catch{/* Recovery remains available through the server history. */}}
function uploadVideo(file:File,onProgress:(percent:number)=>void):Promise<{id:string;meta:{duration:number}}> {
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open("POST","/api/videos");xhr.setRequestHeader("Content-Type","application/octet-stream");xhr.setRequestHeader("X-Cutout-Client","1");xhr.setRequestHeader("X-Video-Filename",encodeURIComponent(file.name));
    xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress(Math.round(event.loaded/event.total*100));};
    xhr.onerror=()=>reject(new Error("视频上传中断，请检查本地服务和网络后重试。"));
    xhr.onabort=()=>reject(new Error("视频上传已取消。"));
    xhr.onload=()=>{void parseResponse<{id:string;meta:{duration:number}}>(new Response(xhr.responseText,{status:xhr.status,statusText:xhr.statusText})).then(resolve,reject);};
    xhr.send(file);
  });
}

export default function useProcessing(props:Props) {
  const [start,setStart]=useState(0),[end,setEnd]=useState(0),[reusable,setReusable]=useState(true);
  const [job,setJob]=useState<Job|null>(null),[output,setOutput]=useState<ExportResult|null>(null);
  const [pending,setPending]=useState<JobInput|null>(()=>{try{return JSON.parse(readStored(PENDING_JOB)??"null") as JobInput|null;}catch{return null;}});
  const [working,setWorking]=useState(false),[message,setMessage]=useState("");
  const [history,setHistory]=useState<Job[]>([]);
  const {apiState,connected,configured}=useBackendHealth();
  const [pollError,setPollError]=useState("");
  const [historyOpen,setHistoryOpen]=useState(false);
  const [hiddenHistoryIds,setHiddenHistoryIds]=useState<Set<string>>(()=>new Set());
  const [removedTask,setRemovedTask]=useState<{id:string;filename:string}|null>(null);
  const undoRemoveButton=useRef<HTMLButtonElement>(null);
  const [historyVideoError,setHistoryVideoError]=useState<string|null>(null);
  const [historyPreview,setHistoryPreview]=useState<{jobId:string;created:string;output:ExportResult}|null>(null);
  const historyDialog=useRef<HTMLDialogElement>(null);
  const [uploadingTask,setUploadingTask]=useState<{fileName:string;state:"uploading"|"failed";progress:number;error?:string;mode:JobInput["mode"];duration:number;start:number;end:number;color:string}|null>(null);
  const [recovering,setRecovering]=useState(true);
  const requestLock=useRef(false),mounted=useRef(true);
  const busy=working || recovering || !!job&&!['completed','failed'].includes(job.state) || !!output&&!['completed','failed'].includes(output.state);
  const hasCompletedJob=job?.state==="completed";
  const editingResult=props.view==="result"&&hasCompletedJob;
  const changed=!!output&&(props.color!==output.color||output.resolution!=="source");
  const cannotRecolor=!!job&&!job.reusable&&props.color!==job.input.color;
  const targetSpec=job?.sourceMeta ? `${job.sourceMeta.width} × ${job.sourceMeta.height}` : "原视频尺寸";
  const outputSpec=output?.meta ? `${output.meta.width} × ${output.meta.height}` : output?.resolution==="source" ? "原视频尺寸" : output?.resolution;
  const needsExport=output?.state!=="completed"||changed;
  const limit=props.mode==="auto"?60:5;
  const selectedDuration=Math.max(0,end-start);
  const validClip=Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&end<=props.duration&&selectedDuration<=limit+.0001;
  const durationStatus=!props.file&&!props.videoId?"上传后自动检查时长，超时可选择处理片段。":props.duration<=0?"正在读取视频时长…":props.duration>limit?(validClip?`所选片段 ${selectedDuration.toFixed(2)} 秒，符合当前模式的 ${limit} 秒上限。`:`视频时长 ${props.duration.toFixed(2)} 秒，超过当前模式的 ${limit} 秒上限，请调整片段范围。`):`视频时长 ${props.duration.toFixed(2)} 秒，符合当前模式的 ${limit} 秒上限。`;
  useEffect(()=>{if(removedTask)undoRemoveButton.current?.focus();},[removedTask]);

  useEffect(()=>{
    const dialog=historyDialog.current;
    if(!historyPreview||!dialog)return;
    dialog.closest(".viewer-panel")?.querySelectorAll("video").forEach(video=>video.pause());
    const video=dialog.querySelector("video");
    dialog.showModal();
    return()=>{video?.pause();};
  },[historyPreview]);

  useEffect(()=>{
    setStart(0);setEnd(props.duration);
  },[props.file,props.videoId,props.duration,props.mode]);
  useEffect(()=>{if(message)setMessage("");},[props.file,props.duration,props.mode,props.prompt,props.points,start,end]);
  useEffect(()=>{props.onBusy(busy);},[busy,props.onBusy]);
  useEffect(()=>{
    if(output?.state==="completed"||output?.state==="failed")props.onResultSettled();
  },[output?.id,output?.state,props.onResultSettled]);
  useEffect(()=>{
    if(job&&(job.state==="failed"||output?.state==="failed")){
      setHistoryOpen(true);
    }
  },[job?.id,job?.state,output?.id,output?.state]);
  useEffect(()=>{
    mounted.current=true;
    try{localStorage.removeItem("bria-cutout.last-job");localStorage.removeItem("bria-cutout.last-export");}catch{/* The fresh source view remains the default even when storage is unavailable. */}
    return()=>{mounted.current=false;};
  },[]);
  useEffect(()=>{
    if(apiState==="checking")return;
    if(apiState==="offline"){setRecovering(false);return;}
    setRecovering(true);
    let cancelled=false;
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),10_000);
    // Load the list once on connection/reconnection; task progress uses individual IDs.
    void api<Job[]>("/api/jobs",undefined,controller.signal).then(rows=>{
      if(cancelled)return;
      setHistory(rows);
      if(rows.some(item=>isActive(item.state)||item.latestAttempt&&isActive(item.latestAttempt.state)))setHistoryOpen(true);
    }).catch(()=>{if(!cancelled)setMessage("任务记录读取失败，可点击刷新记录重试。");}).finally(()=>{clearTimeout(timeout);if(!cancelled)setRecovering(false);});
    return()=>{cancelled=true;clearTimeout(timeout);controller.abort();};
  },[apiState]);

  // One polling loop owns both workspace and history progress, including local exports.
  const tracked=history.filter(row=>!hiddenHistoryIds.has(row.id)).map(row=>row.id===job?.id?{...row,...job,latestAttempt:output??row.latestAttempt}:row);
  if(job&&!tracked.some(row=>row.id===job.id)&&!hiddenHistoryIds.has(job.id))tracked.push({...job,latestAttempt:output??undefined});
  const targets=tracked.filter(row=>isActive(row.state)||row.latestAttempt&&isActive(row.latestAttempt.state)||row.id===job?.id&&!output&&!!row.exportId);
  const pollingKey=targets.map(row=>row.id).sort().join(",");
  const pollingTargets=useRef(targets);pollingTargets.current=targets;
  useEffect(()=>{
    if(!pollingKey){setPollError("");return;}
    let cancelled=false,running=false,timer:ReturnType<typeof setTimeout>,controller:AbortController|undefined;
    async function poll() {
      if(cancelled||document.hidden||running)return;
      running=true;controller=new AbortController();
      const timeout=setTimeout(()=>controller?.abort(),15_000);
      const results=await Promise.allSettled(pollingTargets.current.map(async row=>{
        const detail=isActive(row.state)?await api<Job>(`/api/jobs/${row.id}`,undefined,controller!.signal):row;
        const next={...row,...detail,error:detail.error,warning:detail.warning};
        const attempt=row.latestAttempt;
        const exportId=attempt?.id??next.exportId;
        if(exportId&&(!attempt||isActive(attempt.state)||isActive(row.state))) {
          const result=await api<ExportResult>(`/api/exports/${exportId}`,undefined,controller!.signal);
          next.latestAttempt=result;
          if(result.state==="completed")next.latestExport=result;
        }
        return next;
      }));
      clearTimeout(timeout);running=false;
      if(cancelled)return;
      const updates=results.flatMap(result=>result.status==="fulfilled"?[result.value]:[]);
      setHistory(rows=>rows.map(row=>updates.find(update=>update.id===row.id)??row));
      const current=updates.find(row=>row.id===job?.id);
      if(current){setJob(current);if(current.latestAttempt)setOutput(current.latestAttempt);}
      setPollError(results.some(result=>result.status==="rejected")?"任务状态查询中断，正在重连；不会重新提交抠图任务。":"");
      if(!document.hidden)timer=setTimeout(()=>void poll(),2000);
    }
    function wake(){clearTimeout(timer);if(!document.hidden)void poll();}
    document.addEventListener("visibilitychange",wake);
    timer=setTimeout(()=>void poll(),0);
    return()=>{cancelled=true;clearTimeout(timer);controller?.abort();document.removeEventListener("visibilitychange",wake);};
  },[pollingKey,job?.id]);

  async function action(fn:()=>Promise<void>) {
    if(requestLock.current)return;
    requestLock.current=true;setWorking(true);setMessage("");
    try{await fn();}catch(e){if(mounted.current)setMessage(e instanceof Error?e.message:"请求失败，请检查本地服务。");}
    finally{requestLock.current=false;if(mounted.current)setWorking(false);}
  }
  function revealHistory() {
    setHistoryOpen(true);
    window.setTimeout(()=>document.querySelector(".task-history")?.scrollIntoView({behavior:"smooth",block:"nearest"}),80);
  }
  async function submit(input:JobInput) {
    store(PENDING_JOB,JSON.stringify(input));setPending(input);
    let next:Job;
    try {next=await api<Job>("/api/jobs",input);}
    catch(e) {
      // A local validation rejection created no task; let the operator correct inputs.
      // Network/5xx uncertainty retains the UUID so recovery cannot duplicate a job.
      if(e instanceof ApiError && e.status>=400 && e.status<500) {
        setPending(null);store(PENDING_JOB,null);
      }
      throw e;
    }
    if(!mounted.current)return;
    setJob(next);setOutput(null);setPending(null);store(PENDING_JOB,null);
    setUploadingTask(null);revealHistory();setHistory(rows=>[next,...rows.filter(row=>row.id!==next.id)].slice(0,50));
  }
  function jobValidationError():string {
    if(!props.file&&!props.videoId)return "请先选择视频。";
    if(!props.videoReady)return "正在准备兼容视频预览，请稍候。";
    if(!Number.isFinite(props.duration)||props.duration<=0)return "尚未读取到有效的视频时长，请重新选择视频。";
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>props.duration)return "请检查处理片段的开始和结束时间。";
    if(end-start>limit+.0001)return `当前模式的处理片段不能超过 ${limit} 秒，请先裁短片段。`;
    if(props.mode==="prompt"&&!props.prompt.trim())return "请先填写要保留目标的文字描述。";
    if(props.mode==="points"&&!props.points.some(p=>p.type==="positive"))return "请先暂停视频，用“＋保留”标记目标。";
    return "";
  }
  async function startJob() {
    await action(async()=>{
      const validationError=jobValidationError();
      if(validationError){setMessage(validationError);return;}
      setMessage("");
      if(!props.file&&!props.videoId)return;
      let videoId=props.videoId;
      if(!videoId&&props.file) {
        setUploadingTask({fileName:props.file.name,state:"uploading",progress:0,mode:props.mode,duration:props.duration,start,end,color:props.color});revealHistory();
        try{videoId=(await uploadVideo(props.file,progress=>setUploadingTask(task=>task?{...task,progress}:task))).id;}
        catch(error){setUploadingTask(task=>task?{...task,state:"failed",error:error instanceof Error?error.message:"上传失败"}:task);return;}
      }
      if(!videoId)return;
      await submit({id:crypto.randomUUID(),videoId,mode:props.mode,prompt:props.prompt,points:props.points,start,end,reusable,color:props.color,resolution:"source"});
    });
  }
  async function refreshHistory() {await action(async()=>{setHistory(await api<Job[]>("/api/jobs"));});}
  async function removeTask(item:Job) {
    await action(async()=>{
      await api(`/api/jobs/${item.id}/remove`,{});
      setHiddenHistoryIds(ids=>new Set(ids).add(item.id));
      setRemovedTask({id:item.id,filename:item.filename||`任务 ${item.id.slice(0,8)}`});
    });
  }
  async function undoRemove() {
    if(!removedTask)return;
    const id=removedTask.id;
    await action(async()=>{
      await api(`/api/jobs/${id}/undo-remove`,{});
      const rows=await api<Job[]>("/api/jobs");
      setHistory(rows);setHiddenHistoryIds(ids=>{const next=new Set(ids);next.delete(id);return next;});
      setRemovedTask(null);setHistoryOpen(true);
      requestAnimationFrame(()=>document.querySelector<HTMLElement>(`[data-task-id="${id}"]`)?.focus());
    });
  }
  async function resumeTask(item:Job) {
    await action(async()=>{
      const resumed=await api<Job>(`/api/jobs/${item.id}/resume`,{});
      setHistory(rows=>rows.map(row=>row.id===item.id?{...row,...resumed,error:resumed.error}:row));
      if(job?.id===item.id){setOutput(null);setJob(resumed);}
      revealHistory();
    });
  }
  async function retryExport(item:Job,attempt:ExportResult) {
    await action(async()=>{
      const next=await api<ExportResult>(`/api/jobs/${item.id}/export`,{id:crypto.randomUUID(),color:attempt.color,resolution:"source"});
      setHistory(rows=>rows.map(row=>row.id===item.id?{...row,latestAttempt:next}:row));
      if(job?.id===item.id)setOutput(next);
      revealHistory();
    });
  }
  const clip = props.file&&props.duration>limit ? (
    <fieldset className="processing-options" disabled={busy||!props.file}>
      <div className="group-title"><span className="section-label">选择处理片段</span><span className="default-hint">最多 {limit} 秒</span></div>
      <div className="clip-inputs"><label>开始（秒）<input type="number" min={0} max={props.duration} step="0.01" value={start} onChange={e=>setStart(Number(e.target.value))}/></label><label>结束（秒）<input type="number" min={0} max={props.duration} step="0.01" value={end} onChange={e=>setEnd(Number(e.target.value))}/></label></div>
      <p className="helper">已选 {Math.max(0,end-start).toFixed(2)} 秒。超限时需调整范围，不会自动截断。</p>
    </fieldset>
  ) : null;
  const options = <fieldset className="processing-options export-options" disabled={busy}>
      {props.mode==="auto"&&<label className="cache-choice"><input type="checkbox" checked={reusable} onChange={e=>setReusable(e.target.checked)}/>保留抠图缓存，方便后续换色</label>}
      {props.mode==="auto"&&<p className="helper">缓存占用本机空间，换色时可直接本地导出。关闭后换色需重新调用 Bria。</p>}
    </fieldset>;
  async function exportLocally() {
    if(!job||!hasCompletedJob||!output||busy||cannotRecolor)return;
    await action(async()=>{
      const next=await api<ExportResult>(`/api/jobs/${job.id}/export`,{id:crypto.randomUUID(),color:props.color,resolution:"source"});
      setOutput(next);
      setHiddenHistoryIds(ids=>{const visible=new Set(ids);visible.delete(job.id);return visible;});
      setRemovedTask(item=>item?.id===job.id?null:item);
      setHistory(await api<Job[]>("/api/jobs"));
      revealHistory();
    });
  }
  const actions = <section className="processing-panel" aria-label="处理与导出">
    <div className="action-panel">
      {editingResult ? <>
        {needsExport ? <>
          <button className="primary-button full" disabled={busy||!output||!connected||cannotRecolor} onClick={()=>void exportLocally()}>{busy?"正在本地导出…":output?.state==="failed"?"重试本地导出":"应用修改并导出"}</button>
          <p>{!connected?"处理服务未连接，请检查本地服务和网络后重试。":cannotRecolor?"此结果没有透明缓存，换色需要重新抠图。":`导出${props.colorLabel(props.color)} · ${targetSpec}，仅在本地处理，不再提交 Bria。`}</p>
        </> : <p>导出完成，可预览或下载 MP4。</p>}
        <button className="outline-button full new-task-button" disabled={busy} onClick={props.onEditSource}>重新抠图</button>
      </> : <>
        <button className="primary-button full" data-tour="start" disabled={busy||(!props.file&&!props.videoId)||!props.videoReady||!connected||!configured||!!pending} onClick={()=>void startJob()}>{working?"正在提交抠图任务…":busy?"任务处理中…":"开始抠图并导出"}</button>
        <p>{!connected?"处理服务未连接，请检查本地服务和网络后重试。":!configured?"抠图服务暂不可用，请检查服务端配置和网络。本地文件仍可使用。":!props.file&&!props.videoId?"请先选择视频。":!props.videoReady?"正在准备可预览的视频…":"提交后会调用 Bria 处理所选片段，可能消耗账号额度。"}</p>
      </>}
    </div>
    {message&&<p className="error-text" role="alert">{message}</p>}
    {pending&&!busy&&<button className="outline-button" onClick={()=>void action(async()=>{try{const existing=await api<Job>(`/api/jobs/${pending.id}`);setJob(existing);setPending(null);store(PENDING_JOB,null);}catch(e){if(e instanceof ApiError&&e.status===404)await submit(pending);else throw e;}})}>恢复未确认的提交</button>}
  </section>;
  const result = output&&<div className="result-panel"><h3>导出成品 · {props.colorLabel(output.color)} · {outputSpec}</h3>{output.state==="completed"&&changed&&<p className="pending-change" role="status">待应用：{props.colorLabel(props.color)} · {targetSpec}。当前预览和下载仍是{props.colorLabel(output.color)} · {outputSpec}。</p>}{output.state==="completed"&&output.downloadUrl?<><video key={output.id} src={output.downloadUrl} controls preload="metadata" playsInline aria-label="导出成品预览"/><div className="result-info"><p className="helper">{output.meta?.width} × {output.meta?.height} · {output.meta?.duration.toFixed(2)} 秒 · {((output.bytes??0)/1024/1024).toFixed(1)} MB · {output.meta?.hasAudio?"含音轨":"无音轨"}</p><a className={`${changed?"outline-button":"primary-button"} download-link`} href={`${output.downloadUrl}?download=1`} download>{changed?"下载当前成品":"下载 MP4"}</a></div></>:<div className="result-empty" role={output.state==="failed"?"alert":"status"}><p className={output.state==="failed"?"error-text":"helper"}>{output.state==="failed"?"暂未生成成品，请查看任务记录中的失败原因。":"成品生成后可在这里预览，请在任务记录中查看进度。"}</p></div>}</div>;
  const visibleHistory=history.filter(row=>!hiddenHistoryIds.has(row.id));
  const historyView = <><details className="task-history" open={historyOpen} onToggle={event=>setHistoryOpen(event.currentTarget.open)} data-tour="task-history"><summary>任务记录（最近 50 条）</summary>{visibleHistory.length?<p className="helper">直接预览或下载成品；移除记录不会删除本地视频。</p>:<p className="helper">暂无任务。提交后可在这里查看进度，完成后预览和下载。</p>}
    <button className="outline-button" disabled={busy} onClick={()=>void refreshHistory()}>刷新记录</button>
    {pollError&&<p className="error-text" role="status">{pollError}</p>}
    {removedTask&&<div className="history-removal-notice" role="status"><span>已移除“{removedTask.filename}”的记录，本地视频仍保留。</span><button className="outline-button" ref={undoRemoveButton} disabled={working} onClick={()=>void undoRemove()}>撤销移除</button></div>}
    {uploadingTask&&<div className="history-uploading" role="status">
      <div className="history-entry-summary"><strong title={uploadingTask.fileName}>{uploadingTask.fileName}</strong><span className={uploadingTask.state==="failed"?"history-state failed":"history-state"}>{uploadingTask.state==="uploading"?`上传素材 ${uploadingTask.progress}%`:"上传未完成"}</span></div>
      <div className="history-meta"><span>{MODE_LABELS[uploadingTask.mode]}</span><span>原视频 {uploadingTask.duration.toFixed(2)} 秒</span><span>处理 {(uploadingTask.end-uploadingTask.start).toFixed(2)} 秒</span><span>背景 {props.colorLabel(uploadingTask.color)}</span></div>
      {uploadingTask.state==="uploading"?<><TaskSteps state="local-upload"/><div className="task-progress" role="progressbar" aria-label={`视频上传进度 ${uploadingTask.progress}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadingTask.progress}><span style={{width:`${uploadingTask.progress}%`}} /></div></>:<><p className="error-text">{uploadingTask.error}</p><button className="outline-button" onClick={()=>setUploadingTask(null)}>关闭</button></>}
    </div>}
    {visibleHistory.map(row=>{
    // Live polling owns the current task; keep history metadata and the last playable export.
    const item=row.id===job?.id?{...row,...job,error:job.error,warning:job.warning,latestAttempt:output??row.latestAttempt,latestExport:output?.state==="completed"?output:row.latestExport}:row;
    const attempt=item.latestAttempt;
    const localExport=item.state==="completed"&&attempt&&attempt.state!=="completed";
    const state=localExport?attempt.state:item.state;
    const active=state!=="completed"&&state!=="failed";
    const error=localExport?attempt.error:item.error;
    const completedExport=item.latestExport?.state==="completed"&&item.latestExport.downloadUrl;
    const created=new Date(item.createdAt).toLocaleString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
    const filename=item.filename||`未记录文件名 · ${item.id.slice(0,8)}`;
    const stateLabel=localExport?(state==="failed"?"本地导出失败":"正在本地导出"):LABELS[state]??state;
    return <article className="history-entry" key={item.id} data-task-id={item.id} tabIndex={-1} aria-label={filename}>
      <div className="history-entry-main">
        <div className="history-media" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>
          {historyOpen&&completedExport&&<img key={item.latestExport!.id} className="history-thumbnail" src={`/api/jobs/${item.id}/thumbnail?export=${item.latestExport!.id}`} alt="" loading="lazy" onError={event=>{event.currentTarget.style.display="none";}}/>}
        </div>
        <div className="history-file">
          <strong title={filename}>{filename}</strong>
          <div className="history-meta"><span>{MODE_LABELS[item.input.mode]}</span><span>原视频 {item.videoDuration===undefined?"时长未记录":`${item.videoDuration.toFixed(2)} 秒`}</span><span title={`${item.input.start.toFixed(2)}–${item.input.end.toFixed(2)} 秒`}>处理 {(item.input.end-item.input.start).toFixed(2)} 秒</span><span>背景 {props.colorLabel(attempt?.color??item.input.color)}</span><time dateTime={item.createdAt}>{created}</time></div>
        </div>
        <span className={state==="completed"?"history-state complete":state==="failed"?"history-state failed":"history-state"} aria-live={active?"polite":undefined}>{stateLabel}</span>
        <div className="history-actions" role="group" aria-label={`${filename}的操作`}>
          {completedExport&&<>
            <button className="outline-button" onClick={()=>{setHistoryVideoError(null);setHistoryPreview({jobId:item.id,created:`${filename} · ${created}`,output:item.latestExport!});}}>预览视频</button>
            <a className="primary-button" href={`${completedExport}?download=1`} download>下载视频</a>
          </>}
          {item.state==="failed"&&item.canResume&&<button className="outline-button" disabled={busy} onClick={()=>void resumeTask(item)}>恢复任务</button>}
          {localExport&&state==="failed"&&<button className="outline-button" disabled={busy} onClick={()=>void retryExport(item,attempt)}>重试本地导出</button>}
          <button className="outline-button history-remove" disabled={working||active} title={active?"处理结束后可移除记录":"仅移除记录，保留本地视频"} onClick={()=>void removeTask(item)}>移除记录</button>
        </div>
      </div>
      {active&&<div className="history-progress">{localExport?<p className="helper">本地合成与导出 · 无需重新抠图</p>:<TaskSteps state={state}/>}<div className="task-progress" role="progressbar" aria-label={`任务${stateLabel}`} aria-valuetext={stateLabel}><span className="is-indeterminate"/></div></div>}
      {(error||item.warning||localExport&&completedExport)&&<div className="history-notice">
        {error&&<p className="error-text" role="alert">{error.message}</p>}{item.warning&&<p className="helper">{item.warning}</p>}
        {localExport&&completedExport&&<p className="helper">预览和下载仍为上次成品：{props.colorLabel(item.latestExport!.color)}{item.latestExport!.meta&&` · ${item.latestExport!.meta.width} × ${item.latestExport!.meta.height}`}。</p>}
      </div>}
    </article>;
  })}</details>
    {historyPreview&&<dialog className="history-preview-dialog" ref={historyDialog} aria-labelledby="history-preview-title" onClose={event=>{event.currentTarget.querySelector("video")?.pause();setHistoryPreview(null);}}>
      <div className="history-preview-heading"><div><h2 id="history-preview-title">成品预览</h2><p className="helper">{historyPreview.created}</p></div><button className="outline-button" autoFocus onClick={()=>historyDialog.current?.close()}>关闭预览</button></div>
      <video className="history-video" src={historyPreview.output.downloadUrl} poster={`/api/jobs/${historyPreview.jobId}/thumbnail`} controls preload="metadata" playsInline aria-label="历史任务成品预览" onError={()=>setHistoryVideoError(historyPreview.output.id)}/>
      {historyVideoError===historyPreview.output.id&&<p className="error-text" role="alert">视频暂时无法预览，请下载后播放，或检查本地服务。</p>}
      <div className="history-preview-footer"><p className="helper">{props.colorLabel(historyPreview.output.color)}{historyPreview.output.meta&&` · ${historyPreview.output.meta.width} × ${historyPreview.output.meta.height} · ${historyPreview.output.meta.duration.toFixed(2)} 秒`}</p><a className="outline-button" href={`${historyPreview.output.downloadUrl}?download=1`} download>下载成品 MP4</a></div>
    </dialog>}
  </>;

  // One lifecycle owns polling and recovery; the workspace places each view in task order.
  return {apiState,clip,durationStatus,durationOverLimit:!!props.file&&props.duration>limit&&!validClip,options,actions,result,history:historyView,hasCompletedJob,editingResult,sourceMeta:job?.sourceMeta};
}
