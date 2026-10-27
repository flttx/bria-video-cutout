import assert from 'node:assert/strict';
import {readFile,mkdir,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createServer,preview as createPreview} from 'vite';
import {command} from '../apps/api/src/media.ts';
const root=resolve('.tmp/browser-tests',randomUUID());await mkdir(root,{recursive:true});
const source=resolve(root,'source.mp4'),mask=resolve(root,'mask.mp4'),alpha=resolve(root,'alpha.webm');
await command('ffmpeg',['-y','-f','lavfi','-i','color=c=blue:s=320x180:r=24:d=1','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-vf','drawbox=x=100:y=30:w=100:h=120:color=red:t=fill','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
await command('ffmpeg',['-y','-f','lavfi','-i','color=c=black:s=320x180:r=24:d=1','-vf','drawbox=x=100:y=30:w=100:h=120:color=white:t=fill','-c:v','libx264','-pix_fmt','yuv420p',mask]);
await command('ffmpeg',['-y','-f','lavfi','-i','color=c=blue:s=320x180:r=24:d=1','-vf','drawbox=x=100:y=30:w=100:h=120:color=red:t=fill,format=rgba,colorkey=blue:0.1:0.0','-c:v','libvpx-vp9','-pix_fmt','yuva420p','-auto-alt-ref','0',alpha]);
const fixtures={source:await readFile(source),mask:await readFile(mask),alpha:await readFile(alpha)};
const formats={};
for(const [extension,codec] of [['mov','copy'],['webm','libvpx-vp9'],['avi','mjpeg']]) {
  const path=resolve(root,'source.'+extension);
  await command('ffmpeg',['-y','-i',source,'-an','-c:v',codec,path]);
  formats[extension]=await readFile(path);
}
const source4k=resolve(root,'source4k.mp4'),mask4k=resolve(root,'mask4k.mp4');
await command('ffmpeg',['-y','-f','lavfi','-i','color=c=red:s=3840x2160:r=6:d=0.5','-c:v','libx264','-pix_fmt','yuv420p',source4k]);
await command('ffmpeg',['-y','-f','lavfi','-i','color=c=white:s=1280x720:r=6:d=0.5','-c:v','libx264','-pix_fmt','yuv420p',mask4k]);
const large={source4k:await readFile(source4k),mask4k:await readFile(mask4k)};
const oddPath=resolve(root,'odd.mp4');
await command('ffmpeg',['-y','-f','lavfi','-i','color=c=red:s=162x122:r=20:d=0.2','-vf','format=yuv444p,crop=161:121','-c:v','libx264','-pix_fmt','yuv444p',oddPath]);
const odd=await readFile(oddPath);
const server=await createServer({configFile:resolve('apps/web/vite.config.ts'),root:resolve('apps/web'),server:{host:'127.0.0.1',port:5184,strictPort:true}});await server.listen();
let executablePath=process.env.BROWSER_TEST_EXECUTABLE;
if(!executablePath&&process.platform==='win32')for(const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']){try{await access(candidate);executablePath=candidate;break;}catch{}}
const browser=await chromium.launch({headless:true,executablePath});
let production;
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const jobs=new Map(),uploads=new Map();let submissions=0,loseNext=false,holdNext=false,cloudOffline=false,localApiRequests=0,wasmLoads=0;
await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.hostname!=='127.0.0.1')return route.fulfill({status:200,body:'',contentType:'text/css'});
  if(url.pathname.startsWith('/api/')){localApiRequests++;return route.abort();}
  if(url.pathname==='/fixture/source')return route.fulfill({body:fixtures.source,contentType:'video/mp4'});
  if(url.pathname==='/fixture/source4k')return route.fulfill({body:large.source4k,contentType:'video/mp4'});
  if(url.pathname==='/fixture/mask4k')return route.fulfill({body:large.mask4k,contentType:'video/mp4'});
  if(url.pathname==='/fixture/odd')return route.fulfill({body:odd,contentType:'video/mp4'});
  if(formats[url.pathname.slice('/fixture/'.length)]&&url.pathname.startsWith('/fixture/'))return route.fulfill({body:formats[url.pathname.slice('/fixture/'.length)],contentType:'application/octet-stream'});
  if(url.pathname==='/ffmpeg/manifest.json')wasmLoads++;
  if(!url.pathname.startsWith('/browser/'))return route.continue();
  const reply=(data,status=200)=>route.fulfill({status,json:data});
  if(cloudOffline)return route.abort();
  if(url.pathname==='/browser/health')return reply({ok:true,userId:'test-user',processingReady:true,tokenConfigured:true});
  if(url.pathname==='/browser/uploads'){const uploadId=randomUUID();uploads.set(uploadId,{...request.postDataJSON(),parts:[]});return reply({uploadId,chunkSize:8*1024*1024});}
  if(url.pathname.includes('/parts/')){uploads.get(url.pathname.split('/')[3]).parts.push(request.postDataBuffer());return reply({ok:true});}
  if(url.pathname.endsWith('/complete'))return reply({ok:true});
  if(url.pathname==='/browser/jobs'){
    const data=request.postDataJSON();assert.ok(!jobs.has(data.cloudJobId),'Paid submission must never be repeated');
    submissions++;jobs.set(data.cloudJobId,{...data,hold:holdNext,wasmLoads});holdNext=false;
    if(loseNext){loseNext=false;return route.abort();}return reply({id:data.cloudJobId,state:'processing'});
  }
  const id=url.pathname.split('/')[3],job=jobs.get(id);assert.ok(job,'Unknown cloud job');
  if(url.pathname.endsWith('/artifact'))return route.fulfill({body:job.mode!=='auto'?fixtures.mask:job.color?fixtures.source:fixtures.alpha,contentType:'application/octet-stream'});
  return reply({id,state:job.failed?'failed':job.hold?'processing':'completed',resultAvailable:!job.hold});
});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
async function start(mode='auto',extra={},fixture='source',metaPatch=null) {
  return page.evaluate(async({mode,extra,fixture,metaPatch})=>{
    const {importVideo,browserApi}=await import('/src/browser/pipeline.ts');
    const file=new File([await (await fetch('/fixture/'+fixture)).blob()],'sample.mp4',{type:'video/mp4'});
    const video=await importVideo(file),id=crypto.randomUUID();
    if(metaPatch){Object.assign(video.meta,metaPatch);await (await import('/src/browser/store.ts')).put('video/'+video.id,video);}
    const input={id,videoId:video.id,mode,prompt:mode==='prompt'?'red rectangle':'',points:mode==='points'?[{x:.5,y:.5,type:'positive',atSeconds:.5}]:[],start:0,end:1,reusable:true,color:'White',resolution:'source',...extra};
    await browserApi('/api/jobs',input);return id;
  },{mode,extra,fixture,metaPatch});
}
async function waitForBrowser(fn,arg,options={timeout:120000}) {
 const deadline=Date.now()+options.timeout;
 while(Date.now()<deadline){if(await page.evaluate(fn,arg))return;await new Promise(resolve=>setTimeout(resolve,250));}
 throw new Error('Browser state timed out');
}
async function waitJob(id,state='completed') {
  await waitForBrowser(async({id,state})=>{const {browserApi}=await import('/src/browser/pipeline.ts');const j=await browserApi('/api/jobs/'+id);if(j.state==='failed'&&state!=='failed')throw new Error(JSON.stringify(j.error));return j.state===state;},{id,state},{timeout:120000});
  return page.evaluate(async id=>{const {browserApi}=await import('/src/browser/pipeline.ts');return browserApi('/api/jobs/'+id);},id);
}
try {
  await page.goto('http://127.0.0.1:5184');
  await page.evaluate(()=>{for(const mode of ['auto','prompt','points'])localStorage.setItem('bria-cutout.guide.'+mode+'.v1','1');});await page.reload();
  assert.equal(await page.evaluate(async()=>{
    const {importVideo}=await import('/src/browser/pipeline.ts');
    try{await importVideo(new File(['invalid video'],'broken.mp4',{type:'video/mp4'}));return false;}catch{return true;}
  }),true,'Corrupt input must fail, including the adapted ffprobe return code');
  for(const mode of ['auto','prompt','points']) {
    const beforeLoads=wasmLoads;
    const id=await start(mode),job=await waitJob(id);
    const cloudJob=jobs.get(job.cloudJobId),uploaded=uploads.get(cloudJob.uploadId),uploadedBytes=Buffer.concat(uploaded.parts);
    assert.equal(uploaded.mediaType,'video/mp4');assert.equal(uploadedBytes.length,uploaded.size);
    if(mode==='auto'){
      assert.deepEqual(uploadedBytes,fixtures.source,'Full auto must upload original bytes');
      assert.equal(cloudJob.wasmLoads-beforeLoads,1,'Only initial probe may load WASM before full auto submission');
    }else{
      assert.notDeepEqual(uploadedBytes,fixtures.source,'Mask modes must keep their prepared proxy');
      assert.equal(cloudJob.wasmLoads-beforeLoads,2);
    }
    if(!job.latestExport)throw new Error(JSON.stringify({state:job.state,error:job.error,attempt:job.latestAttempt}));
    assert.equal(job.latestExport.meta.width,320);assert.equal(job.latestExport.meta.height,180);assert.equal(job.latestExport.meta.frames,24);assert.equal(job.latestExport.meta.hasAudio,true);
    assert.match(job.latestExport.downloadUrl,/^blob:/);assert.equal(job.state,'completed');
    assert.match(job.thumbnailUrl,/^blob:/);
    const stats=await page.evaluate(async url=>{const video=document.createElement('video');video.src=url;await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=reject;});return {width:video.videoWidth,height:video.videoHeight};},job.latestExport.downloadUrl);
    assert.deepEqual(stats,{width:320,height:180});
    const before=submissions;cloudOffline=true;
    const exportId=await page.evaluate(async id=>{const {browserApi}=await import('/src/browser/pipeline.ts');const result=await browserApi('/api/jobs/'+id+'/export',{id:crypto.randomUUID(),color:'Blue',resolution:'source'});return result.id;},id);
    await waitForBrowser(async id=>{const {browserApi}=await import('/src/browser/pipeline.ts');const e=await browserApi('/api/exports/'+id);if(e.state==='failed')throw new Error(JSON.stringify(e.error));return e.state==='completed';},exportId,{timeout:120000});
    cloudOffline=false;assert.equal(submissions,before);console.log(mode+': real WASM probe, prepare, composite, audio, frames, playable MP4 and offline recolor passed');
  }
  const direct=await start('auto',{reusable:false});assert.equal((await waitJob(direct)).reusable,false);
  loseNext=true;const lost=await start('prompt');await waitJob(lost,'failed');const before=submissions;
  await page.reload();await page.evaluate(async id=>{const {browserApi}=await import('/src/browser/pipeline.ts');await browserApi('/api/jobs/'+id+'/resume',{});},lost);await waitJob(lost);assert.equal(submissions,before);
  console.log('Lost submission response: reload and recovery by original cloud ID passed');
  holdNext=true;const interrupted=await start('points');await waitForBrowser(async id=>{const {browserApi}=await import('/src/browser/pipeline.ts');return (await browserApi('/api/jobs/'+id)).state==='processing';},interrupted,{timeout:120000});
  const second=await context.newPage();await second.goto('http://127.0.0.1:5184');
  await second.evaluate(async()=>{const {browserApi}=await import('/src/browser/pipeline.ts');await browserApi('/api/jobs');});await second.close();
  const beforeReload=submissions;for(const job of jobs.values())job.hold=false;await page.reload();await waitJob(interrupted);assert.equal(submissions,beforeReload);
  await page.getByRole('button',{name:'刷新记录',exact:true}).click();
  await page.getByRole('button',{name:'预览视频',exact:true}).first().click();
  await page.waitForSelector('dialog[open] video');
  await page.getByRole('button',{name:'关闭预览',exact:true}).click();
  const download=page.waitForEvent('download');await page.getByRole('link',{name:'下载视频',exact:true}).first().click();assert.ok((await download).suggestedFilename().endsWith('.mp4'));
  await page.screenshot({path:resolve(root,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(root,'mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(localApiRequests,0);assert.deepEqual(errors,[]);
  console.log('Browser refresh recovery, UI, mobile width and zero local API HTTP requests passed');
  const started=Date.now();
  const smoke=await page.evaluate(async()=>{
    const media=await import('/src/browser/media.ts');
    return media.mediaSession(async()=>{
      await media.writeBlob('input',await (await fetch('/fixture/source4k')).blob());
      const original=await media.probe('input');
      const source=await media.prepare('input','source.mp4',{start:0,end:.5},original);
      const proxy=await media.proxy('source.mp4','proxy.mp4');
      await media.writeBlob('mask.mp4',await (await fetch('/fixture/mask4k')).blob());
      await media.validateArtifact('mask.mp4',source,'mask');
      const result=await media.render('source.mp4','mask.mp4','mask','output.mp4',{color:'White',resolution:'source'},source);
      return {source:result.meta,proxy};
    });
  });
  assert.equal(smoke.source.width,3840);assert.equal(smoke.source.height,2160);assert.equal(smoke.source.frames,3);assert.equal(smoke.proxy.height,720);
  console.log('4K WASM smoke passed: 3840x2160, 3 frames, '+Math.round((Date.now()-started)/1000)+'s; synthetic short clip only.');
  production=await createPreview({configFile:resolve('apps/web/vite.config.ts'),root:resolve('apps/web'),preview:{host:'127.0.0.1',port:5185,strictPort:true}});
  const built=await context.newPage();
  await built.addInitScript(()=>{for(const mode of ['auto','prompt','points'])localStorage.setItem('bria-cutout.guide.'+mode+'.v1','1');});
  await built.goto('http://127.0.0.1:5185');
  await built.locator('input[type=file]').setInputFiles({name:'sample.mp4',mimeType:'video/mp4',buffer:fixtures.source});
  await built.getByRole('button',{name:'开始抠图并导出',exact:true}).click();
  await built.getByRole('link',{name:'下载 MP4',exact:true}).waitFor({timeout:120000});
  await built.locator('video[aria-label="导出成品预览"]').evaluate(async video=>{await video.play();await new Promise(resolve=>setTimeout(resolve,250));video.pause();});
  const builtDownload=built.waitForEvent('download');await built.getByRole('link',{name:'下载 MP4',exact:true}).click();
  assert.equal((await builtDownload).suggestedFilename(),'cutout.mp4');
  await built.screenshot({path:resolve(root,'production-result.png'),fullPage:true});
  assert.equal(localApiRequests,0);console.log('Production build: UI file selection → real WASM → mocked cloud → playable downloadable MP4 passed.');
  holdNext=true;const clipped=await start('auto',{start:.25,end:.75});const clippedJob=await waitJob(clipped,'processing');
  const clippedCloud=jobs.get(clippedJob.cloudJobId),clippedUpload=uploads.get(clippedCloud.uploadId);
  assert.notDeepEqual(Buffer.concat(clippedUpload.parts),fixtures.source,'Explicit clip must not upload the full original');
  assert.equal(clippedCloud.meta.frames,12);assert.equal(clippedCloud.meta.duration,.5);
  console.log('Original-byte auto upload without prepare WASM, retained Mask proxy and exact explicit clipping passed.');
  for(const [format,mediaType] of [['mov','video/quicktime'],['webm','video/webm'],['avi','video/x-msvideo']]) {
    holdNext=true;const beforeLoads=wasmLoads;
    const id=await start('auto',{},format),job=await waitJob(id,'processing'),cloudJob=jobs.get(job.cloudJobId),uploaded=uploads.get(cloudJob.uploadId);
    assert.equal(uploaded.mediaType,mediaType,'MIME must come from media probing, not filename or File.type');
    assert.deepEqual(Buffer.concat(uploaded.parts),formats[format]);assert.equal(cloudJob.wasmLoads-beforeLoads,1);
  }
  console.log('MOV, WebM and AVI: original upload bytes and sniffed MIME passed despite misleading .mp4 filename.');
  holdNext=true;const legacy=await start('auto',{},'source',{uploadMediaType:undefined,containerDuration:undefined});
  const legacyJob=await waitJob(legacy,'processing'),legacyUpload=uploads.get(jobs.get(legacyJob.cloudJobId).uploadId);
  assert.deepEqual(Buffer.concat(legacyUpload.parts),fixtures.source,'Old local metadata must be reprobed for original upload');
  holdNext=true;const audioTail=await start('auto',{},'source',{containerDuration:60.2});
  const audioJob=await waitJob(audioTail,'processing'),audioUpload=uploads.get(jobs.get(audioJob.cloudJobId).uploadId);
  assert.notDeepEqual(Buffer.concat(audioUpload.parts),fixtures.source,'An over-limit container duration must use selected-clip preparation');
  console.log('Legacy metadata upgrade and over-limit container fallback passed.');
  const oddExport=await page.evaluate(async()=>{
    const media=await import('/src/browser/media.ts');
    return media.mediaSession(async()=>{
      await media.writeBlob('odd.mp4',await (await fetch('/fixture/odd')).blob());
      const source=await media.probe('odd.mp4');
      const result=await media.render('odd.mp4','odd.mp4','direct','even.mp4',{color:'White',resolution:'source'},source);
      return {source:source.width,output:result.meta};
    });
  });
  assert.equal(oddExport.source,161);assert.equal(oddExport.output.width,162);assert.equal(oddExport.output.height,122);assert.equal(oddExport.output.frames,4);
  console.log('Unnormalized odd-size original is padded only at final H.264 export; frame QA passed.');
  for(const job of jobs.values())if(job.hold)job.failed=true;
  await waitForBrowser(async()=>{
    const store=await import('/src/browser/store.ts');
    return (await store.list('job/')).every(job=>['completed','failed'].includes(job.state));
  });
} finally {await browser.close();await server.close();if(production)await new Promise(resolve=>production.httpServer.close(resolve));}
