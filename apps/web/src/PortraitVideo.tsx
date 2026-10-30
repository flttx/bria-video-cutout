import { useEffect, useId, useRef, useState } from 'react';

export default function PortraitVideo({src,label,downloadUrl}:{src:string;label:string;downloadUrl?:string}){
  const [open,setOpen]=useState(false),title=useId();
  const inline=useRef<HTMLVideoElement>(null),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if(!open)return;
    const element=dialog.current!;element.showModal();
    return()=>{element.querySelector('video')?.pause();element.close();};
  },[open]);
  return <div className="portrait-video">
    <div className="portrait-video-stage"><video ref={inline} src={src} controls playsInline preload="metadata" aria-label={label}/></div>
    <div className="portrait-video-actions">
      <button ref={trigger} className="outline-button" onClick={()=>{inline.current?.pause();setOpen(true);}}>查看视频</button>
      {downloadUrl&&<a className="primary-button" href={downloadUrl} download>导出视频</a>}
    </div>
    {open&&<dialog ref={dialog} className="history-preview-dialog portrait-video-dialog" aria-labelledby={title} onClose={event=>{event.currentTarget.querySelector('video')?.pause();setOpen(false);trigger.current?.focus();}}>
      <div className="history-preview-heading"><h2 id={title}>查看视频</h2><button className="outline-button" onClick={()=>dialog.current?.close()} autoFocus>关闭</button></div>
      <div className="portrait-video-stage"><video src={src} controls playsInline preload="metadata" aria-label={`${label}查看`}/></div>
      {downloadUrl&&<div className="portrait-video-actions"><a className="primary-button" href={downloadUrl} download>导出视频</a></div>}
    </dialog>}
  </div>;
}
