import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createNativeServer } from '../apps/api/src/native.js';
import { MAX_BYTES } from '../apps/api/src/model.js';
import { command, probe } from '../apps/api/src/media.js';

test('native helper restricts origins/host/client, bounds uploads, rejects invalid media and cleans temporary files',async()=>{
  const root=await mkdtemp(resolve('.tmp/native-security-'));
  const app=await createNativeServer(root);
  const headers={'host':'127.0.0.1:3002','x-cutout-client':'1'};
  const renderHeaders={...headers,'content-type':'application/octet-stream','x-cutout-render':JSON.stringify({sourceBytes:1,kind:'alpha',color:'White',resolution:'source'})};
  try {
    assert.equal((await app.inject({url:'/native/health',headers})).statusCode,200);
    for(const extra of [{origin:'https://evil.example'},{host:'evil.example:3002'},{'sec-fetch-site':'cross-site'},{'x-cutout-client':''}]){
      assert.equal((await app.inject({url:'/native/health',headers:{...headers,...extra}})).statusCode,403);
    }
    assert.equal((await app.inject({method:'POST',url:'/native/render',headers:{...renderHeaders,'x-cutout-render':'{'},payload:'ab'})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:'/native/render',headers:{...renderHeaders,'x-cutout-render':JSON.stringify({sourceBytes:MAX_BYTES+1,kind:'alpha',color:'White'})},payload:'ab'})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:'/native/render',headers:renderHeaders,payload:'a'})).statusCode,413);
    const result=await app.inject({method:'POST',url:'/native/render',headers:renderHeaders,payload:'ab'});
    assert.equal(result.statusCode,422);assert.ok(!result.body.includes(root));
    assert.deepEqual(await readdir(root),[]);
  }finally{await app.close();}
});

test('native HTTP exports a 653-frame rotated 720p Alpha clip and verifies source audio/rate',async()=>{
  const root=await mkdtemp(resolve('.tmp/native-720p-'));
  const source=resolve(root,'source.mp4'),rotated=resolve(root,'rotated.mp4'),artifact=resolve(root,'alpha.webm');
  await command('ffmpeg',['-y','-f','lavfi','-i','color=c=blue:s=1280x720:r=1498/25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-vf','drawbox=x=0:y=0:w=640:h=720:color=red:t=fill','-frames:v','653','-t',String(653/59.92),'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',source]);
  await command('ffmpeg',['-y','-display_rotation','90','-i',source,'-c','copy',rotated]);
  await command('ffmpeg',['-y','-f','lavfi','-i','color=c=blue:s=1280x720:r=60','-vf','drawbox=x=0:y=0:w=640:h=720:color=red:t=fill,format=rgba,colorkey=blue:0.1:0.0','-frames:v','653','-c:v','libvpx-vp9','-cpu-used','8','-deadline','realtime','-threads','2','-pix_fmt','yuva420p','-auto-alt-ref','0',artifact]);
  const folder=resolve(root,'requests'),app=await createNativeServer(folder);
  try {
    const address=await app.listen({host:'127.0.0.1',port:0}),original=await readFile(rotated);
    const started=performance.now();
    const response=await fetch(address+'/native/render',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Cutout-Client':'1','X-Cutout-Render':JSON.stringify({sourceBytes:original.length,kind:'alpha',color:'White',resolution:'source'})},body:Buffer.concat([original,await readFile(artifact)])});
    assert.equal(response.status,200,await (response.ok?Promise.resolve(''):response.text()));
    const file=resolve(root,'output.mp4');await writeFile(file,Buffer.from(await response.arrayBuffer()));
    const seconds=(performance.now()-started)/1000,meta=await probe(file,true);
    assert.equal(meta.width,720);assert.equal(meta.height,1280);assert.equal(meta.frames,653);assert.equal(meta.hasAudio,true);assert.ok(Math.abs(meta.fps-59.92)<.001);
    console.log(`Native 720x1280 synthetic 653-frame HTTP transfer/validation/export: ${seconds.toFixed(2)}s (not a real-source performance guarantee).`);
  }finally{await app.close();}
  assert.deepEqual(await readdir(folder),[]);
});
