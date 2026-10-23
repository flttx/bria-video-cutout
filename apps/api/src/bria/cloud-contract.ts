import { COLORS } from "../config.js";
import type { MaskPoint } from "../config.js";
import type { ColorName } from "../model.js";
import { validId } from "../model.js";
import { AppError, object } from "../errors.js";
import { parseStatus } from "./protocol.js";
import type { BriaStatusResponse } from "./protocol.js";

export interface PreparedMeta { width:number; height:number; duration:number; fps:number; frames:number }
export interface CloudJobInput {
  cloudJobId:string;
  uploadId:string;
  mode:"auto"|"prompt"|"points";
  meta:PreparedMeta;
  color?:ColorName;
  prompt?:string;
  frame_index?:number;
  key_points?:MaskPoint[];
}
export interface CloudJobView {
  id:string;
  state:"submitting"|"processing"|"completed"|"failed"|"rejected"|"uncertain";
  status?:BriaStatusResponse;
  httpStatus?:number;
}
export function parseCloudView(value:unknown):CloudJobView {
  const v=object(value),id=validId(v.id);
  if(!["submitting","processing","completed","failed","rejected","uncertain"].includes(String(v.state)))throw new AppError("CLOUD_RESPONSE","云端任务响应无效。",502);
  return {id,state:v.state as CloudJobView["state"],status:v.status===undefined?undefined:parseStatus(v.status),httpStatus:typeof v.httpStatus==="number"?v.httpStatus:undefined};
}
// Canonical field order is also the idempotency fingerprint input. Unknown fields are rejected.
function keys(value:Record<string,unknown>,allowed:string[]) {
  if(Object.keys(value).some(key=>!allowed.includes(key)))throw new AppError("INVALID_INPUT","请求包含不支持的字段。");
}
export function parseCloudInput(value:unknown):CloudJobInput {
  const v=object(value);
  keys(v,["cloudJobId","uploadId","mode","meta","color","prompt","frame_index","key_points"]);
  const cloudJobId=validId(v.cloudJobId),uploadId=validId(v.uploadId),m=object(v.meta);
  keys(m,["width","height","duration","fps","frames"]);
  for(const key of ["width","height","duration","fps","frames"] as const)if(typeof m[key]!=="number"||!Number.isFinite(m[key])||m[key]<=0)throw new AppError("INVALID_META","预处理视频信息无效。");
  const meta:PreparedMeta={width:m.width as number,height:m.height as number,duration:m.duration as number,fps:m.fps as number,frames:m.frames as number};
  if(!Number.isInteger(meta.width)||!Number.isInteger(meta.height)||!Number.isInteger(meta.frames)||meta.width>16000||meta.height>16000||meta.fps>120||Math.abs(meta.frames-meta.duration*meta.fps)>2)throw new AppError("INVALID_META","预处理视频规格无效。");
  if(v.mode!=="auto"&&v.mode!=="prompt"&&v.mode!=="points")throw new AppError("INVALID_MODE","抠图模式无效。");
  if(meta.duration>(v.mode==="auto"?60:5)+0.001)throw new AppError("INVALID_CLIP","视频片段超过当前模式的时长上限。");
  if(v.mode!=="auto"&&(meta.width>1280||meta.height>720))throw new AppError("INVALID_META","Mask 模式须使用本地生成的 1280×720 范围内代理。");
  const result:CloudJobInput={cloudJobId,uploadId,mode:v.mode,meta};
  if(v.mode==="auto") {
    if(v.prompt!==undefined||v.frame_index!==undefined||v.key_points!==undefined)throw new AppError("INVALID_INPUT","自动模式不接受文字或点位。");
    if(v.color!==undefined) {
      if(!COLORS.some(c=>c.name===v.color))throw new AppError("INVALID_COLOR","请选择十种预设色之一。");
      result.color=v.color as ColorName;
    }
  } else {
    if(v.color!==undefined)throw new AppError("INVALID_COLOR","Mask 的背景色由本地合成。");
    if(v.mode==="prompt") {
      if(typeof v.prompt!=="string"||!v.prompt.trim()||v.prompt.length>2000||v.frame_index!==undefined||v.key_points!==undefined)throw new AppError("INVALID_PROMPT","请输入不超过 2000 字的目标描述。");
      result.prompt=v.prompt.trim();
    } else {
      if(v.prompt!==undefined||!Number.isInteger(v.frame_index)||Number(v.frame_index)<0||Number(v.frame_index)>=meta.frames||!Array.isArray(v.key_points)||!v.key_points.length||v.key_points.length>100)throw new AppError("INVALID_POINTS","点选帧或点位无效。");
      result.frame_index=v.frame_index as number;
      result.key_points=v.key_points.map(value=>{
        const p=object(value);keys(p,["x","y","type"]);
        if(!Number.isInteger(p.x)||!Number.isInteger(p.y)||Number(p.x)<0||Number(p.y)<0||Number(p.x)>=meta.width||Number(p.y)>=meta.height||(p.type!=="positive"&&p.type!=="negative"))throw new AppError("INVALID_POINTS","点位须位于代理画面内。");
        return {x:p.x as number,y:p.y as number,type:p.type};
      });
      if(!result.key_points.some(p=>p.type==="positive"))throw new AppError("INVALID_POINTS","至少需要一个保留点。");
    }
  }
  return result;
}
