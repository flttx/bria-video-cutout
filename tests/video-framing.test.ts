import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { command, probe, render } from '../apps/api/src/media.js';
import { AppError } from '../apps/api/src/errors.js';

test('video framing uses the complete motion envelope with one scale, preserves audio and blank frames, and supports masks',async()=>{
  const root=resolve('.tmp/video-framing',randomUUID());await mkdir(root,{recursive:true});
  const raw=resolve(root,'frames.rgba'),source=resolve(root,'source.mp4'),alpha=resolve(root,'alpha.webm'),mask=resolve(root,'mask.mp4');
  const width=180,height=320,frames=12,frameBytes=width*height*4,data=Buffer.alloc(frameBytes*frames);
  for(let n=0;n<frames;n++){
    for(let i=n*frameBytes;i<(n+1)*frameBytes;i+=4)data[i+2]=255;
    if(n===6)continue;
    const fill=(x:number,y:number,w:number,h:number)=>{for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)data.set([220,20,10,255],n*frameBytes+(j*width+i)*4);};
    fill(20+n*6,180,36,80);
    // A brief last-frame extremity must be included, not missed by sampling.
    if(n===11)fill(130,50,4,4);
  }
  await writeFile(raw,data);
  const rawInput=['-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-framerate','6','-i',raw];
  await command('ffmpeg',['-y',...rawInput,'-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
  await command('ffmpeg',['-y',...rawInput,'-c:v','libvpx-vp9','-lossless','1','-pix_fmt','yuva420p','-auto-alt-ref','0',alpha]);
  await command('ffmpeg',['-y',...rawInput,'-vf','alphaextract','-c:v','libx264','-crf','0','-pix_fmt','yuv420p',mask]);
  const sourceMeta=await probe(source,true);
  for(const kind of ['alpha','mask'] as const){
    const output=resolve(root,`${kind}.mp4`),result=await render(source,kind==='alpha'?alpha:mask,kind,output,{color:'White',resolution:'source',framing:'subject'},sourceMeta);
    assert.deepEqual(result.composition?.bounds,{x:20,y:50,width:114,height:210});
    assert.equal(result.meta.width,width);assert.equal(result.meta.height,height);assert.equal(result.meta.frames,12);assert.equal(result.meta.fps,6);assert.equal(result.meta.hasAudio,true);
    const target=result.composition!.target;
    assert.ok(target.width<=width*.66&&target.height<=height*.58);
    const decoded=resolve(root,`${kind}.rgb`);await command('ffmpeg',['-y','-i',output,'-map','0:v:0','-pix_fmt','rgb24','-f','rawvideo',decoded]);
    const rgb=await readFile(decoded),boxes=[];
    for(let n=0;n<frames;n++){
      let left=width,right=-1,top=height,bottom=-1;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const i=(n*width*height+y*width+x)*3;
        if(rgb[i]!>120&&rgb[i+1]!<100&&rgb[i+2]!<100){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
      }
      if(n===6){assert.equal(right,-1,'empty frame stays empty');continue;}
      assert.ok(left>=target.x-2&&right<=target.x+target.width+2&&top>=target.y-2&&bottom<=target.y+target.height+2,'no visible subject outside the target area');
      if(n===11){assert.ok(top<target.y+5,'last-frame extremity survives');continue;}
      boxes.push({x:left,w:right-left+1,h:bottom-top+1,y:top});
    }
    assert.ok(boxes.at(-1)!.x>boxes[0]!.x+40,'original horizontal motion remains');
    assert.ok(Math.max(...boxes.map(b=>b.w))-Math.min(...boxes.map(b=>b.w))<=3,'no size pumping');
    assert.ok(Math.max(...boxes.map(b=>b.h))-Math.min(...boxes.map(b=>b.h))<=3,'height stable');
    assert.ok(Math.max(...boxes.map(b=>b.y))-Math.min(...boxes.map(b=>b.y))<=2,'no added vertical jitter');
  }
  const wideSource=resolve(root,'wide-source.mp4'),wideAlpha=resolve(root,'wide-alpha.webm');
  await command('ffmpeg',['-y','-i',source,'-vf','setsar=2/1','-c:v','libx264','-c:a','copy',wideSource]);
  await command('ffmpeg',['-y',...rawInput,'-vf','setsar=2/1','-c:v','libvpx-vp9','-lossless','1','-pix_fmt','yuva420p','-auto-alt-ref','0',wideAlpha]);
  const wideMeta=await probe(wideSource,true);
  const wide=await render(wideSource,wideAlpha,'alpha',resolve(root,'wide.mp4'),{color:'White',resolution:'source',framing:'subject'},wideMeta);
  assert.equal(wide.meta.width,360);assert.equal(wide.meta.height,320);
  assert.ok(wide.composition!.bounds.width>=228&&wide.composition!.bounds.width<=240,'non-square pixels are normalized before measuring');
  assert.equal(wide.composition!.bounds.height,210);
  await assert.rejects(render(source,source,'direct',resolve(root,'invalid.mp4'),{color:'White',resolution:'source',framing:'subject'},sourceMeta),(e:unknown)=>e instanceof AppError&&e.code==='FRAMING_REQUIRES_ALPHA');
  const empty=resolve(root,'empty.webm');await command('ffmpeg',['-y','-f','lavfi','-i','color=black@0:s=180x320:r=6:d=2,format=rgba','-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0',empty]);
  await assert.rejects(render(source,empty,'alpha',resolve(root,'empty.mp4'),{color:'White',resolution:'source',framing:'subject'},sourceMeta),(e:unknown)=>e instanceof AppError&&e.code==='VIDEO_SUBJECT_EMPTY');
  console.log(`Video framing evidence: ${root}`);
});
