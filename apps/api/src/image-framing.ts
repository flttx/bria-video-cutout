import { randomUUID } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import { AppError } from './errors.js';
import { command } from './media.js';

// Engineering layout from the user's lower red box, not a provider guarantee.
export const KLING_FRAME = {version:2,width:1080,height:1920,left:0.17,top:0.30,widthRatio:0.66,heightRatio:0.58} as const;
export interface SubjectBounds {x:number;y:number;width:number;height:number}
export interface ImageFraming {version:number;width:number;height:number;sourceBounds:SubjectBounds;subjectBox:SubjectBounds}

export async function frameKlingImage(alphaFile:string,output:string):Promise<ImageFraming> {
  const scratch=`${output}.${randomUUID()}`,raw=`${scratch}.raw`,temp=`${scratch}.png`;
  const ffmpeg=(args:string[])=>command('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-threads','2','-filter_threads','1','-filter_complex_threads','1',...args],120000);
  try{
    const info=JSON.parse(await command('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-select_streams','v:0','-show_entries','stream=width,height','-of','json',alphaFile],30000)) as {streams?:{width?:number;height?:number}[]};
    const {width=0,height=0}=info.streams?.[0]??{};
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192||width*height>24_000_000)
      throw new AppError('IMAGE_FRAMING_INVALID','无法读取用于构图的透明图片。',422);
    // Use the actual Bria alpha, including pale/white parts and thin protrusions.
    // RGB/white-background thresholding would lose those parts of the subject.
    await ffmpeg(['-protocol_whitelist','file,pipe','-i',alphaFile,'-vf','alphaextract','-frames:v','1','-pix_fmt','gray','-f','rawvideo',raw]);
    const pixels=await readFile(raw);
    if(pixels.length!==width*height)throw new AppError('IMAGE_FRAMING_INVALID','透明图片尺寸校验失败。',422);
    let left=width,top=height,right=-1,bottom=-1;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(pixels[y*width+x]!>0){
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
    }
    if(right<left)throw new AppError('IMAGE_SUBJECT_EMPTY','Bria 结果没有可见主体，已停止生成视频。',422);
    // Fit the exact visible bounds. Fixed source-pixel padding would make small
    // source subjects appear smaller after enlargement than large source subjects.
    const sourceBounds={x:left,y:top,width:right-left+1,height:bottom-top+1};
    const f=KLING_FRAME,scale=Math.min(f.width*f.widthRatio/sourceBounds.width,f.height*f.heightRatio/sourceBounds.height);
    const w=Math.max(1,Math.floor(sourceBounds.width*scale)),h=Math.max(1,Math.floor(sourceBounds.height*scale));
    const x=Math.round(f.width*(f.left+f.widthRatio/2)-w/2),y=Math.round(f.height*(f.top+f.heightRatio/2)-h/2);
    await ffmpeg(['-protocol_whitelist','file,pipe','-i',alphaFile,'-filter_complex',
      `[0:v]format=rgba,crop=${sourceBounds.width}:${sourceBounds.height}:${left}:${top},scale=${w}:${h}:flags=lanczos,setsar=1[fg];color=c=white:s=${f.width}x${f.height},format=rgb24[bg];[bg][fg]overlay=x=${x}:y=${y}:format=rgb:shortest=1,format=rgb24[out]`,
      '-map','[out]','-frames:v','1','-c:v','png',temp]);
    await rename(temp,output);
    return {version:f.version,width:f.width,height:f.height,sourceBounds,subjectBox:{x,y,width:w,height:h}};
  }finally{await Promise.all([rm(raw,{force:true}),rm(temp,{force:true})]);}
}
