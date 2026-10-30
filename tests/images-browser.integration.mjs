import assert from 'node:assert/strict';
import { mkdir, copyFile, access, writeFile, readFile, utimes, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { createServer } from '../apps/api/src/app.ts';
import { Pipeline } from '../apps/api/src/pipeline.ts';
import { Store } from '../apps/api/src/store.ts';
import { command } from '../apps/api/src/media.ts';

const root=resolve('.tmp/images-browser',randomUUID());await mkdir(root,{recursive:true});
const source=resolve(root,'product.png'),alpha=resolve(root,'alpha.png'),generatedVideo=resolve(root,'kling.mp4');
await command('ffmpeg',['-y','-f','lavfi','-i','color=c=0x64748b:s=360x640,format=rgba,drawbox=x=100:y=150:w=160:h=340:color=0xff6b35:t=fill','-frames:v','1',source]);
await command('ffmpeg',['-y','-i',source,'-vf','colorkey=0x64748b:0.1:0.0','-frames:v','1',alpha]);
await command('ffmpeg',['-y','-f','lavfi','-i','color=white:s=1080x1920:r=24:d=6,drawbox=x=300:y=500:w=480:h=900:color=0xff6b35:t=fill','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',generatedVideo]);
let submissions=0,klingSubmissions=0,hold=true,klingHold=true,klingQueued=true,videoPosts=0,whiteReads=0;
let releaseDownload;const downloadGate=new Promise(resolve=>{releaseDownload=resolve;});
const gateway={imageForeground:async()=>{submissions++;return {request_id:'synthetic-image-browser'};},
  status:async()=>({status:hold?'IN_PROGRESS':'COMPLETED',result:{image_url:'https://example.invalid/signed-image'}}),download:async(_url,file)=>{
    await writeFile(file+'.part',Buffer.alloc(1048576));const old=new Date(Date.now()-90000);await utimes(file+'.part',old,old);
    await downloadGate;await copyFile(alpha,file);await rm(file+'.part',{force:true});
  },
  upload:async()=>{throw new Error('unexpected video upload');},autoForeground:async()=>{throw new Error('unexpected video call');},
  maskByPrompt:async()=>{throw new Error('unexpected mask');},maskByPoints:async()=>{throw new Error('unexpected mask');}};
const kling={region:'china',submit:async file=>{assert.ok(file.endsWith('kling-input.png'));klingSubmissions++;return 'kling_'+klingSubmissions;},
  query:async id=>({id,status:klingQueued?'submitted':klingHold?'processing':'succeeded',url:'https://example.invalid/private-kling'}),download:async(_url,file)=>copyFile(generatedVideo,file)};
const engine=new Pipeline(new Store(resolve(root,'data')),gateway,20,60000,{},undefined,kling);
const token='synthetic-images-browser-password',origin='http://127.0.0.1:5197';
const app=await createServer(engine,true,undefined,undefined,{origin,proxyToken:token,mode:'basic'});
const address=await app.listen({host:'127.0.0.1',port:0});let server,browser,page;
try{
 process.env.CUTOUT_API_BASE_URL=address;process.env.CUTOUT_API_PATH_PREFIX='';process.env.CUTOUT_API_USERNAME='admin';process.env.CUTOUT_API_PASSWORD=token;
 server=await preview({configFile:resolve('apps/web/vite.config.ts'),root:resolve('apps/web'),mode:'server',preview:{host:'127.0.0.1',port:5197,strictPort:true}});
 let executablePath=process.env.BROWSER_TEST_EXECUTABLE;
 if(!executablePath&&process.platform==='win32')for(const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']){try{await access(candidate);executablePath=candidate;break;}catch{}}
 browser=await chromium.launch({headless:true,executablePath});const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(()=>{for(const mode of ['auto','prompt','points'])localStorage.setItem('bria-cutout.guide.'+mode+'.v1','1');});
 const forbidden=[],errors=[];
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.hostname!=='127.0.0.1'||/^\/(api|browser|native|ffmpeg)\//.test(url.pathname)){forbidden.push(url.pathname);return route.abort();}
  if(route.request().headers().authorization)forbidden.push('browser-authorization');
  if(url.pathname.includes('/api/models'))forbidden.push('removed-model-api');
  if(/\/images\/[^/]+\/file$/.test(url.pathname))whiteReads++;
  if(url.pathname.endsWith('/image-videos')&&route.request().method()==='POST'){
   videoPosts++;
   if(videoPosts===1){const result=await route.fetch();assert.equal(result.status(),202);return route.abort();}
  }
  return route.continue();
 });
 page=await context.newPage();page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 assert.equal(await page.getByRole('button',{name:'图片转 3D',exact:true}).count(),0);
 await page.getByRole('button',{name:'图片白底',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('input[aria-label="选择图片文件"]').disabled);
 await page.getByLabel('选择图片文件').setInputFiles({name:'bad.txt',mimeType:'text/plain',buffer:Buffer.from('not an image')});
 await page.getByRole('alert').filter({hasText:'请选择不超过'}).waitFor();assert.equal(submissions,0);
 await page.getByLabel('选择图片文件').setInputFiles(source);
 await page.getByRole('status').filter({hasText:'Bria 正在处理图片'}).waitFor();assert.equal(videoPosts,1,'upload automatically starts once despite lost response');
 assert.equal(await page.getByAltText('白底处理结果').count(),0);assert.equal(await page.getByRole('link',{name:'下载白底 PNG'}).count(),0);
 assert.equal(await page.getByRole('button',{name:'生成白底图片',exact:true}).count(),0);assert.equal(await page.getByLabel('处理 API').count(),0);
 await page.screenshot({path:resolve(root,'processing-desktop.png'),fullPage:true});
 await page.reload();await page.getByRole('button',{name:'图片白底',exact:true}).click();await page.locator('.image-white-history summary').click();await page.locator('.image-white-history button').first().click();
 hold=false;await page.getByRole('status').filter({hasText:'Bria 已完成，正在下载透明图片'}).waitFor();
 await page.getByText('已下载 1.00 MiB',{exact:false}).waitFor();await page.getByRole('status').filter({hasText:'超过 60 秒未收到新数据'}).waitFor();
 assert.equal(klingSubmissions,0);await page.screenshot({path:resolve(root,'white-download-stalled.png'),fullPage:true});
 releaseDownload();await page.getByRole('status').filter({hasText:'可灵平台排队中'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'平台排队中…',exact:true}).isDisabled(),true);
 await page.getByText('最近确认平台状态：',{exact:false}).waitFor();
 await page.screenshot({path:resolve(root,'kling-queued.png'),fullPage:true});
 klingQueued=false;await page.getByRole('status').filter({hasText:'可灵正在生成旋转视频'}).waitFor();assert.equal(submissions,1);assert.equal(klingSubmissions,1);assert.equal(videoPosts,1);
 klingHold=false;await engine.idle();await page.getByRole('link',{name:'下载可灵 MP4'}).waitFor();
 const video=page.getByLabel('可灵旋转视频',{exact:true});await video.evaluate(video=>video.play());await page.waitForFunction(()=>document.querySelector('video[aria-label="可灵旋转视频"]')?.currentTime>0.2);
 const ratio=async locator=>{const box=await locator.boundingBox();assert.ok(Math.abs(box.width/box.height-9/16)<0.002,JSON.stringify(box));};
 await ratio(video);
 await page.getByRole('button',{name:'查看视频',exact:true}).click();const dialog=page.getByRole('dialog',{name:'查看视频',exact:true});await dialog.waitFor();
 assert.equal(await video.evaluate(video=>video.paused),true);
 const dialogVideo=dialog.getByLabel('可灵旋转视频查看');await ratio(dialogVideo);await dialogVideo.evaluate(video=>video.play());
 await page.waitForFunction(()=>document.querySelector('dialog video')?.currentTime>0.2);
 await page.screenshot({path:resolve(root,'view-desktop.png'),fullPage:true});
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await page.getByRole('button',{name:'查看视频',exact:true}).evaluate(button=>button===document.activeElement),true);
 await page.getByRole('button',{name:'查看视频',exact:true}).click();await page.getByRole('button',{name:'关闭',exact:true}).click();await dialog.waitFor({state:'hidden'});
 const downloadEvent=page.waitForEvent('download');await page.getByRole('link',{name:'下载可灵 MP4'}).click();await (await downloadEvent).saveAs(resolve(root,'download.mp4'));
 await page.screenshot({path:resolve(root,'result-desktop.png'),fullPage:true});
 for(const width of [320,390,768,1440]){
  await page.setViewportSize({width,height:900});await ratio(video);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`No overflow at ${width}`);
  await page.getByRole('button',{name:'查看视频',exact:true}).click();await ratio(dialog.getByLabel('可灵旋转视频查看'));
  if(width===390)await page.screenshot({path:resolve(root,'view-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'关闭',exact:true}).click();await dialog.waitFor({state:'hidden'});
 }
 await page.setViewportSize({width:390,height:900});await page.screenshot({path:resolve(root,'result-mobile.png'),fullPage:true});
 // A second new upload auto-starts; opening a previously uploaded image does not.
 const previousVideo=await page.getByRole('link',{name:'下载可灵 MP4'}).getAttribute('href');
 await page.getByLabel('选择图片文件').setInputFiles(source);
 await page.waitForFunction(previous=>{const link=document.querySelector('.kling-video a.primary-button');return link&&link.getAttribute('href')!==previous;},previousVideo);
 assert.equal(submissions,2);assert.equal(klingSubmissions,2);assert.equal(videoPosts,2);
 const untouched=await app.inject({method:'POST',url:'/api/images',headers:{origin,authorization:'Basic '+Buffer.from('admin:'+token).toString('base64'),'x-cutout-client':'1','content-type':'application/octet-stream','x-video-filename':'history-only.png'},payload:await readFile(source)});assert.equal(untouched.statusCode,201);
 await page.reload();await page.getByRole('button',{name:'图片白底',exact:true}).click();await page.locator('.image-white-history summary').click();await page.locator('.image-white-history button').filter({hasText:'history-only.png'}).click();
 await page.getByRole('button',{name:'生成白底旋转视频',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('.kling-video button.primary-button')?.disabled);assert.equal(videoPosts,2);assert.equal(submissions,2);
 await page.route('**/bria-cutout/api/health',route=>route.fulfill({json:{ok:true,imageWhiteEnabled:false,klingVideoEnabled:false}}));
 await page.reload();await page.getByRole('button',{name:'图片白底',exact:true}).click();await page.locator('.image-white-history summary').click();await page.locator('.image-white-history button').filter({hasText:'product.png'}).first().click();
 await page.getByRole('link',{name:'下载可灵 MP4'}).waitFor();assert.equal(await page.getByRole('button',{name:'更换图片并生成'}).isDisabled(),true);assert.equal(videoPosts,2);
 await page.route('**/bria-cutout/api/health',route=>route.fulfill({json:{ok:true}}));await page.reload();await page.getByRole('button',{name:'图片白底',exact:true}).click();
 await page.getByText(/生成服务未就绪/).waitFor();assert.equal(await page.getByRole('button',{name:'选择图片并生成'}).isDisabled(),true);
 assert.equal(whiteReads,0,'browser never downloads the intermediate white image');assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);
 await writeFile(resolve(root,'result.json'),JSON.stringify({status:'passed',submissions,klingSubmissions,videoPosts,whiteReads,errors,forbidden,viewports:[320,390,768,1440],ratio:'9:16 inline and dialog',providers:'mocked'},null,2));
 console.log(`PASS: automatic upload -> Bria -> Kling; no intermediate image; lost-response/reload/cache safety; 9:16 playback and modal at four widths; keyboard/focus and download. Providers mocked. Evidence: ${root}`);
}catch(error){if(page)await page.screenshot({path:resolve(root,'failure.png'),fullPage:true});console.error('Evidence: '+root);throw error;}
finally{hold=false;releaseDownload();klingHold=false;klingQueued=false;await browser?.close();await new Promise(resolve=>server?server.httpServer.close(resolve):resolve());await engine.idle();await app.close();}
