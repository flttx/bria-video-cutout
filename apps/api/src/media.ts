import { spawn } from "node:child_process";
import { copyFile, open as openFile, rename, rm, stat } from "node:fs/promises";
import { AppError } from "./errors.js";
import { COLORS } from "./config.js";
import type { ExportOptions, ExportRecord, JobInput, VideoMeta } from "./model.js";

export async function command(executable:string,args:string[],timeout=1_800_000):Promise<string> {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let output="";
    const timer=setTimeout(()=>{child.kill();reject(new AppError("MEDIA_TIMEOUT","本地视频处理超时，请缩短视频后重试。",500));},timeout);
    child.stdout.on("data",(data:Buffer)=>{if(output.length<8_000_000)output+=data.toString();});
    // FFmpeg diagnostics contain local paths; never send them to app logs or clients.
    child.stderr.resume();
    child.once("error",()=>{clearTimeout(timer);reject(new AppError("MEDIA_TOOL_MISSING","无法启动 FFmpeg/FFprobe，请确认已安装并加入 PATH。",503));});
    child.once("close",code=>{clearTimeout(timer);code===0?resolve(output):reject(new AppError("MEDIA_FAILED","视频解析或编码失败，请检查文件是否完整、编码是否支持及磁盘空间。",422));});
  });
}
const ffmpeg=(args:string[])=>command("ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-threads","2","-filter_complex_threads","1","-filter_threads","1",...args]);
const input=(file:string)=>["-protocol_whitelist","file,pipe","-i",file];
function rate(value:unknown):number {
  const [a,b]=String(value??"0").split("/").map(Number);
  return b ? a!/b : a!;
}
interface Stream {codec_type?:string;codec_name?:string;width?:number;height?:number;avg_frame_rate?:string;duration?:string;nb_frames?:string;nb_read_frames?:string;pix_fmt?:string;sample_aspect_ratio?:string;tags?:Record<string,string>;side_data_list?:{rotation?:number}[]}
function ebmlValue(data:Buffer,offset:number,identifier:boolean):{value:number;length:number}|undefined {
  const first=data[offset];if(first===undefined||first===0)return;
  let length=1,mask=0x80;
  while(!(first&mask)&&length<=8){length++;mask>>=1;}
  if(length>8||offset+length>data.length)return;
  let value=identifier?first:first&(mask-1);
  for(let i=1;i<length;i++)value=value*256+data[offset+i]!;
  return {value,length};
}
async function sourceContainer(file:string):Promise<string> {
  const handle=await openFile(file,"r"),head=Buffer.alloc(65536);
  let length:number;
  try {({bytesRead:length}=await handle.read(head,0,head.length,0));}finally{await handle.close();}
  const data=head.subarray(0,length);
  if(data.subarray(0,6).toString("ascii")==="GIF87a"||data.subarray(0,6).toString("ascii")==="GIF89a")return "gif";
  if(data.subarray(0,4).toString("ascii")==="RIFF"&&data.subarray(8,12).toString("ascii")==="AVI ")return "avi";
  if(data.subarray(4,8).toString("ascii")==="ftyp") {
    const brand=data.subarray(8,12).toString("ascii");
    if(brand==="qt  ")return "mov";
    if(["isom","iso2","iso3","iso4","iso5","iso6","mp41","mp42","mp71","avc1","M4V ","MSNV","dash"].includes(brand))return "mp4";
  }
  if(["moov","mdat","wide","free","skip"].includes(data.subarray(4,8).toString("ascii")))return "mov";
  if(data.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) {
    const header=ebmlValue(data,4,false);if(!header)return "";
    let offset=4+header.length,end=Math.min(data.length,offset+header.value);
    while(offset<end) {
      const id=ebmlValue(data,offset,true);if(!id)return "";offset+=id.length;
      const size=ebmlValue(data,offset,false);if(!size)return "";offset+=size.length;
      if(id.value===0x4282)return data.subarray(offset,offset+size.value).toString("ascii");
      offset+=size.value;
    }
  }
  return "";
}
export async function probe(file:string,count=false):Promise<VideoMeta> {
  const raw=await command("ffprobe",["-v","error","-protocol_whitelist","file,pipe",...(count?["-count_frames"]:[]),"-show_streams","-show_format","-of","json",file],120000);
  let info:{streams?:Stream[];format?:{duration?:string;format_name?:string}};
  try {info=JSON.parse(raw) as typeof info;} catch {throw new AppError("INVALID_VIDEO","无法读取视频信息。",422);}
  const v=info.streams?.find(s=>s.codec_type==="video");
  const duration=Number(v?.duration??info.format?.duration),fps=rate(v?.avg_frame_rate);
  if(!v?.width || !v.height || !Number.isFinite(duration) || duration<=0 || !Number.isFinite(fps) || fps<=0 || fps>120 || !/(mov|mp4|matroska|webm|avi|gif)/.test(info.format?.format_name??"")) throw new AppError("INVALID_VIDEO","需要有效的视频文件；请使用 Bria 支持的 MP4、MOV、WebM、AVI 或 GIF，并检查每秒 1–120 帧的本地处理范围。",422);
  const format=info.format?.format_name??"";
  const container=await sourceContainer(file);
  const supportedContainer=["mp4","mov","webm","avi","gif"].includes(container)&&format.split(",").includes(container);
  const supportedCodec=["h264","hevc","vp9","av1","mjpeg"].includes(v.codec_name??"");
  if(!supportedContainer||(!supportedCodec&&!(container==="gif"&&v.codec_name==="gif"))) {
    throw new AppError("UNSUPPORTED_VIDEO_FORMAT","Bria 支持 MP4、MOV、WebM、AVI、GIF 容器，以及 H.264、H.265、VP9、AV1 或 PhotoJPEG 编码；当前文件格式或编码不在支持范围内。",415);
  }
  const sar=rate(v.sample_aspect_ratio?.replace(":","/")??"1/1")||1;
  let width=Math.round(v.width*sar),height=v.height;
  const rotation=Math.abs(v.side_data_list?.find(x=>x.rotation!==undefined)?.rotation??0)%180;
  if(rotation===90) [width,height]=[height,width];
  if(width>16000 || height>16000 || width<2 || height<2) throw new AppError("VIDEO_DIMENSIONS","视频尺寸不在支持范围内。",422);
  const hasAlphaTag=Object.entries(v.tags??{}).some(([key,value])=>key.toLowerCase()==="alpha_mode"&&value==="1");
  return {width,height,duration,fps,hasAudio:!!info.streams?.some(s=>s.codec_type==="audio"),codec:v.codec_name??"",pixelFormat:v.pix_fmt??"",frames:Number(v.nb_read_frames??v.nb_frames)||Math.round(duration*fps),alpha:hasAlphaTag || /^yuva|rgba|bgra|argb|abgr|gbrap/.test(v.pix_fmt??"")};
}
export async function compatiblePreview(source:string,output:string,meta:VideoMeta):Promise<void> {
  const temp=output+".part.mp4";
  try {
    await ffmpeg([...input(source),"-map","0:v:0","-map","0:a:0?","-vf",`fps=${meta.fps},scale=w='min(1280,iw*sar)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`,"-t",String(meta.duration),"-c:v","libx264","-threads","2","-preset","fast","-crf","20","-pix_fmt","yuv420p","-c:a","aac","-b:a","128k","-ac","2","-movflags","+faststart",temp]);
    await rename(temp,output);
  } catch(e) {await rm(temp,{force:true});throw e;}
}
export async function createThumbnail(source:string,output:string,duration:number):Promise<void> {
  try { await stat(output); return; } catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT") throw e; }
  const temp=output+".part.jpg";
  try {
    await ffmpeg(["-ss",String(Math.max(0,Math.min(duration*.1,1))),...input(source),"-map","0:v:0","-frames:v","1","-vf","scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=0x141412","-q:v","4",temp]);
    await rename(temp,output);
  } catch(e) { await rm(temp,{force:true}); throw e; }
}
export async function prepare(source:string,output:string,inputOptions:JobInput,meta:VideoMeta):Promise<VideoMeta> {
  const frames=Math.floor((inputOptions.end-inputOptions.start)*meta.fps+1e-6);
  if(frames<1) throw new AppError("CLIP_TOO_SHORT","裁选片段必须至少包含一帧。");
  // Normalize display geometry after rotation/SAR; odd dimensions gain at most one edge pixel for 4:2:0.
  await ffmpeg([...input(source),"-ss",String(inputOptions.start),"-map","0:v:0","-map","0:a:0?","-vf",`fps=${meta.fps},scale=${meta.width}:${meta.height},setsar=1,pad=ceil(iw/2)*2:ceil(ih/2)*2,setpts=PTS-STARTPTS`,"-frames:v",String(frames),"-t",String(frames/meta.fps),"-c:v","libx264","-threads","2","-preset","fast","-crf","18","-pix_fmt","yuv420p","-c:a","aac","-b:a","192k","-af","asetpts=PTS-STARTPTS,apad","-movflags","+faststart",output]);
  return probe(output,true);
}
export async function proxy(source:string,output:string):Promise<VideoMeta> {
  await ffmpeg([...input(source),"-map","0:v:0","-an","-vf","scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1","-c:v","libx264","-threads","2","-preset","fast","-crf","18","-pix_fmt","yuv420p",output]);
  return probe(output,true);
}
export async function validateArtifact(file:string,source:VideoMeta,kind:"mask"|"alpha"|"direct"):Promise<VideoMeta> {
  const meta=await probe(file,true);
  if(Math.abs(meta.duration-source.duration)>Math.max(.15,2/source.fps) || Math.abs(meta.frames-source.frames)>1 || Math.abs(meta.fps-source.fps)>.05) throw new AppError("RESULT_ALIGNMENT","Bria 结果的帧数、帧率或时长与源片段不一致，已停止导出以避免错位。",422);
  if(Math.abs(meta.width/meta.height-source.width/source.height)>.02) throw new AppError("RESULT_ASPECT","Bria 结果画面比例与源视频不一致，无法安全合成。",422);
  if(kind==="alpha") {
    if(!meta.alpha) throw new AppError("ALPHA_MISSING","Bria 返回的视频不含透明通道，不能作为可换色结果。",422);
    await ffmpeg([...(meta.codec==="vp9"?["-c:v","libvpx-vp9"]:[]),...input(file),"-vf","alphaextract","-frames:v","1","-f","null","-"]);
  }
  return meta;
}
export async function render(source:string,artifact:string,kind:"mask"|"alpha"|"direct",output:string,options:ExportOptions,sourceMeta:VideoMeta):Promise<{meta:VideoMeta;bytes:number;route:ExportRecord["route"]}> {
  const width=options.resolution==="source"?sourceMeta.width:options.resolution==="4K"?3840:2560;
  const height=options.resolution==="source"?sourceMeta.height:options.resolution==="4K"?2160:1440;
  const color=COLORS.find(c=>c.name===options.color)!.hex.replace("#","0x");
  const artifactMeta=await probe(artifact);
  const temp=output+".part.mp4";
  let route:ExportRecord["route"];
  try {
    if(kind==="direct" && artifactMeta.width===width && artifactMeta.height===height && artifactMeta.codec==="h264" && artifactMeta.pixelFormat==="yuv420p" && artifactMeta.hasAudio===sourceMeta.hasAudio) {
      await copyFile(artifact,temp); route="direct_bria_mp4";
    } else {
      const fit=`scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`;
      let args:string[],filter:string;
      if(kind==="direct") {
        args=[...input(artifact),...input(source)];
        filter=`[0:v]setpts=PTS-STARTPTS,${fit},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${color}[out]`;
        route="transcode_only";
      } else {
        args=[...(kind==="alpha"&&artifactMeta.codec==="vp9"?["-c:v","libvpx-vp9"]:[]),...input(artifact),...input(source)];
        const aligned=`settb=expr=1/${sourceMeta.fps},setpts=N`;
        const foreground=kind==="mask" ? `[0:v]${aligned},scale=${sourceMeta.width}:${sourceMeta.height},format=gray[mask];[1:v]${aligned},format=rgba[rgb];[rgb][mask]alphamerge=shortest=1[fg];` : `[0:v]${aligned},format=rgba[fg];`;
        filter=foreground+`[fg]${fit}[fit];color=c=${color}:s=${width}x${height}:r=${sourceMeta.fps}:d=${sourceMeta.duration}[bg];[bg][fit]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1:format=auto,format=yuv420p[out]`;
        route=kind==="mask"?"mask_composite":"alpha_composite";
      }
      // Convert sample values as well as signaling: -pix_fmt alone can retain full-range yuvj420p.
      filter+=";[out]scale=in_range=auto:out_range=tv,format=yuv420p[encoded]";
      await ffmpeg([...args,"-filter_complex",filter,"-map","[encoded]","-map","1:a:0?","-c:v","libx264","-threads","2","-preset","fast","-crf","18","-pix_fmt","yuv420p","-color_range","tv","-r",String(sourceMeta.fps),"-frames:v",String(sourceMeta.frames),"-t",String(sourceMeta.duration),"-c:a","aac","-b:a","192k","-movflags","+faststart",temp]);
    }
    const meta=await probe(temp,true);
    if(meta.width!==width || meta.height!==height || meta.codec!=="h264" || meta.pixelFormat!=="yuv420p" || meta.hasAudio!==sourceMeta.hasAudio || Math.abs(meta.fps-sourceMeta.fps)>.05 || Math.abs(meta.duration-sourceMeta.duration)>Math.max(.15,2/sourceMeta.fps) || meta.frames!==sourceMeta.frames) throw new AppError("EXPORT_QA_FAILED","导出文件未通过尺寸、编码、音轨或帧率/帧数校验，未标记为完成。",422);
    await rename(temp,output);
    return {meta,bytes:(await stat(output)).size,route};
  } catch(e) {await rm(temp,{force:true});throw e;}
}
