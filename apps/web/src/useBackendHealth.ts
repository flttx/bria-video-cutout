import { useEffect, useState } from "react";
import { api } from "./api";

// The header and submission controls share one health check lifecycle.
export default function useBackendHealth() {
  const [state,setState]=useState<"checking"|"online"|"offline">("checking");
  const [configured,setConfigured]=useState(false);
  useEffect(()=>{
    let stopped=false,running=false,interval=60_000,lastCheck=0;
    let timer:ReturnType<typeof setTimeout>,controller:AbortController|undefined;
    function schedule(delay:number) {
      clearTimeout(timer);
      if(!stopped&&!document.hidden)timer=setTimeout(()=>void check(),delay);
    }
    async function check() {
      if(stopped||document.hidden||running)return;
      running=true;controller=new AbortController();
      const timeout=setTimeout(()=>controller?.abort(),10_000);
      try {
        const data=await api<{tokenConfigured:boolean;processingReady?:boolean}>("/api/health",undefined,controller.signal);
        if(!stopped){setConfigured(data.processingReady??data.tokenConfigured);setState("online");interval=data.processingReady===false?15_000:60_000;}
      } catch {
        if(!stopped){setState("offline");interval=15_000;}
      } finally {
        clearTimeout(timeout);running=false;lastCheck=Date.now();schedule(interval);
      }
    }
    function wake() {schedule(Math.max(0,interval-(Date.now()-lastCheck)));}
    function online() {if(interval===15_000)lastCheck=0;wake();}
    document.addEventListener("visibilitychange",wake);
    window.addEventListener("online",online);
    schedule(0);
    return()=>{stopped=true;clearTimeout(timer);controller?.abort();document.removeEventListener("visibilitychange",wake);window.removeEventListener("online",online);};
  },[]);
  return {apiState:state,connected:state==="online",configured};
}
