import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface TourStep { target:string; title:string; body:string }
interface Props { steps:TourStep[]; modeLabel:string; onClose:()=>void }
interface Rect { left:number;top:number;width:number;height:number;tipLeft:number;tipTop:number }

export default function GuidedTour({steps,modeLabel,onClose}:Props) {
  const [index,setIndex]=useState(0),[rect,setRect]=useState<Rect|null>(null);
  const rootRef=useRef<HTMLDivElement>(null),previousFocus=useRef<HTMLElement|null>(null);
  const step=steps[index];
  const measure=useCallback((scroll=false)=>{
    if(!step)return;
    const target=document.querySelector<HTMLElement>(step.target);
    if(scroll)target?.scrollIntoView({block:"center",inline:"nearest",behavior:"auto"});
    requestAnimationFrame(()=>{
      if(!target){setRect(null);return;}
      const r=target.getBoundingClientRect(),pad=6,tipW=Math.min(360,window.innerWidth-32),tipH=220,gap=16,margin=16;
      const below=r.bottom+gap+tipH<=window.innerHeight-margin;
      const top=Math.max(margin,Math.min(below?r.bottom+gap:r.top-gap-tipH,window.innerHeight-tipH-margin));
      const left=Math.max(margin,Math.min(r.left+r.width/2-tipW/2,window.innerWidth-tipW-margin));
      setRect({left:r.left-pad,top:r.top-pad,width:r.width+pad*2,height:r.height+pad*2,tipLeft:left,tipTop:top});
    });
  },[step]);
  useLayoutEffect(()=>{setIndex(0);previousFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;requestAnimationFrame(()=>{rootRef.current?.focus();measure(true);});return()=>previousFocus.current?.focus({preventScroll:true});},[]);
  useLayoutEffect(()=>{measure(true);},[index,measure]);
  useLayoutEffect(()=>{
    if(!rect||!step)return;
    const target=document.querySelector<HTMLElement>(step.target),card=rootRef.current?.querySelector<HTMLElement>(".guide-card");
    if(!target||!card)return;
    const bounds=target.getBoundingClientRect(),width=card.getBoundingClientRect().width,margin=16;
    const left=Math.max(margin,Math.min(bounds.left+bounds.width/2-width/2,window.innerWidth-width-margin));
    if(Math.abs(rect.tipLeft-left)>1)setRect(current=>current?{...current,tipLeft:left}:current);
  },[rect,step]);
  useEffect(()=>{
    const onResize=()=>measure();
    window.addEventListener("resize",onResize);window.addEventListener("scroll",onResize,true);
    return()=>{window.removeEventListener("resize",onResize);window.removeEventListener("scroll",onResize,true);};
  },[measure]);
  const next=()=>index===steps.length-1?onClose():setIndex(value=>value+1);
  const previous=()=>setIndex(value=>Math.max(0,value-1));
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){event.preventDefault();onClose();}
      else if(event.key==="ArrowRight"){event.preventDefault();next();}
      else if(event.key==="ArrowLeft"){event.preventDefault();previous();}
      else if(event.key==="Tab"){
        const buttons=rootRef.current?.querySelectorAll<HTMLButtonElement>("button");
        if(!buttons?.length)return;
        const first=buttons[0]!,last=buttons[buttons.length-1]!;
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    };
    window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey);
  },[index,onClose,steps.length]);
  if(!step)return null;
  return createPortal(<div className="guide-root" ref={rootRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${modeLabel}新手引导`}>
    {rect?<div className="guide-spotlight" style={{left:rect.left,top:rect.top,width:rect.width,height:rect.height}}/>:<div className="guide-dim"/>}
    <section className={rect?"guide-card":"guide-card guide-card-centered"} style={rect?{left:rect.tipLeft,top:rect.tipTop}:undefined}>
      <div className="guide-count">{modeLabel} · {index+1}/{steps.length}</div>
      <h2>{step.title}</h2><p>{step.body}</p>
      <div className="guide-actions"><button type="button" className="guide-skip" onClick={onClose}>跳过</button><span>{index>0&&<button type="button" onClick={previous}>上一步</button>}<button type="button" className="guide-next" onClick={next}>{index===steps.length-1?"完成":"下一步"}</button></span></div>
    </section>
  </div>,document.body);
}
