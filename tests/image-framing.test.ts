import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { frameKlingImage } from '../apps/api/src/image-framing.js';
import { command } from '../apps/api/src/media.js';
import { AppError } from '../apps/api/src/errors.js';

test('different source sizes and positions fit the same lower-middle box without stretching or losing extremities',async()=>{
  const root=resolve('.tmp/image-framing-tests',randomUUID());await mkdir(root,{recursive:true});
  const cases=[{x:20,y:40,w:60,h:90},{x:100,y:180,w:240,h:360},{x:2,y:400,w:350,h:100},{x:250,y:0,w:50,h:600}];
  const visible=[];
  for(const [index,box] of cases.entries()){
    const raw=resolve(root,`${index}.rgba`),source=resolve(root,`${index}.png`),output=resolve(root,`${index}-framed.png`);
    const data=Buffer.alloc(360*640*4);
    for(let y=box.y;y<box.y+box.h;y++)for(let x=box.x;x<box.x+box.w;x++){
      const offset=(y*360+x)*4;data[offset]=200;data[offset+1]=40;data[offset+2]=30;data[offset+3]=255;
    }
    // A white thin extension must influence bounds even though it blends into white.
    if(index===2)for(let x=0;x<box.x;x++)data.set([255,255,255,255],(box.y*360+x)*4);
    await writeFile(raw,data);
    await command('ffmpeg',['-y','-f','rawvideo','-pixel_format','rgba','-video_size','360x640','-i',raw,'-frames:v','1',source]);
    const layout=await frameKlingImage(source,output),b=layout.subjectBox;
    assert.equal(layout.width,1080);assert.equal(layout.height,1920);
    assert.ok(Math.abs(b.x+b.width/2-540)<=0.5);assert.ok(Math.abs(b.y+b.height/2-1132.8)<=0.5);
    assert.ok(b.width<=713&&b.height<=1114);assert.ok(b.x>=183&&b.y>=576);
    assert.ok(Math.abs(b.width/b.height-layout.sourceBounds.width/layout.sourceBounds.height)<0.02);
    if(index===2)assert.equal(layout.sourceBounds.x,0,'white extension was not mistaken for background');
    const decoded=resolve(root,`${index}.rgb`);
    await command('ffmpeg',['-y','-i',output,'-pix_fmt','rgb24','-frames:v','1','-f','rawvideo',decoded]);
    const rgb=await readFile(decoded);assert.equal(rgb.length,1080*1920*3);assert.deepEqual([...rgb.subarray(0,3)],[255,255,255]);
    let minX=1080,minY=1920,maxX=-1,maxY=-1;
    for(let y=0;y<1920;y++)for(let x=0;x<1080;x++){
      const i=(y*1080+x)*3;if(rgb[i+1]!<150){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
    }
    assert.ok(maxX>minX&&maxY>minY,'nonempty actual pixels');
    if(index<2)assert.ok(maxY-minY+1>1000,'portrait subjects occupy over half the frame height');
    assert.ok(minX>=183&&maxX<=897&&minY>=576&&maxY<=1689,'actual subject fits target area');
    assert.ok(Math.abs((minX+maxX)/2-540)<8&&Math.abs((minY+maxY)/2-1132.8)<8,'actual subject is at the intended center');
    visible.push({width:maxX-minX+1,height:maxY-minY+1});
  }
  // Changing the source subject size must not change its normalized size.
  assert.ok(Math.abs(visible[0]!.height-visible[1]!.height)<30);
  assert.ok(Math.abs(visible[0]!.width-visible[1]!.width)<20);
});

test('empty alpha is rejected instead of submitting an empty white reference',async()=>{
  const root=resolve('.tmp/image-framing-tests',randomUUID());await mkdir(root,{recursive:true});
  const source=resolve(root,'empty.png'),output=resolve(root,'output.png');
  await command('ffmpeg',['-y','-f','lavfi','-i','color=white@0:s=360x640,format=rgba','-frames:v','1',source]);
  await assert.rejects(frameKlingImage(source,output),(error:unknown)=>error instanceof AppError&&error.code==='IMAGE_SUBJECT_EMPTY');
  await assert.rejects(access(output));
});
