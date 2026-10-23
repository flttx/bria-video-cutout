import { AppError } from "../errors.js";
import { BriaClient } from "./client.js";
import type { BriaGateway } from "./client.js";
import { CloudBriaClient } from "./cloud.js";

export function gatewaySettings(env:Record<string,string|undefined>) {
  const mode=env.BRIA_TRANSPORT?.trim()||"direct";
  if(mode!=="direct"&&mode!=="cloud")throw new AppError("TRANSPORT_CONFIG","BRIA_TRANSPORT 只能为 direct 或 cloud。",503);
  const gateways:Partial<Record<"direct"|"cloud",BriaGateway>>={};
  if(env.BRIA_API_TOKEN?.trim())gateways.direct=new BriaClient(env.BRIA_API_TOKEN.trim());
  let cloud:CloudBriaClient|undefined,cloudError:AppError|undefined;
  if(env.CUTOUT_CLOUD_URL||env.CUTOUT_CLOUD_TOKEN||mode==="cloud") {
    try {cloud=new CloudBriaClient(env.CUTOUT_CLOUD_URL?.trim()??"",env.CUTOUT_CLOUD_TOKEN?.trim()??"");gateways.cloud=cloud;}
    catch{cloudError=new AppError("CLOUD_CONFIG","云端处理服务尚未配置，请检查服务端配置并重启。",503);}
  }
  return {mode,gateways,selected:gateways[mode],checkService:mode==="cloud"?async()=>{
    if(cloudError)throw cloudError;
    await cloud!.health();
  }:undefined};
}
