import assert from 'node:assert/strict';
import {access,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {command} from '../apps/api/src/media.ts';

// Real browser metadata and WASM probe; all cloud requests are intercepted, with no paid work.
const root=resolve('.tmp/duration-tests',randomUUID());await mkdir(root,{recursive:true});
const short=resolve(root,'audio-tail.mp4'),boundary=resolve(root,'boundary.mp4'),overLimit=resolve(root,'over-limit.mp4');
for(const [file,duration] of [[short,1],[boundary,5],[overLimit,5.1]]) {
  await command('ffmpeg',['-y','-f','lavfi','-i',`color=c=red:s=160x120:r=20:d=${duration}`,'-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${duration+.22}`,'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',file]);
}
let executablePath=process.env.BROWSER_TEST_EXECUTABLE;
if(!executablePath&&process.platform==='win32')for(const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']){try{await access(candidate);executablePath=candidate;break;}catch{}}
const server=await createServer({configFile:resolve('apps/web/vite.config.ts'),root:resolve('apps/web'),server:{host:'127.0.0.1',port:5186,strictPort:true}});
await server.listen();
const browser=await chromium.launch({headless:true,executablePath});
async function fixture(mode,file,reportedDuration) {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  context.setDefaultTimeout(30000);
  await context.addInitScript(value=>{
    for(const name of ['auto','prompt','points'])localStorage.setItem('bria-cutout.guide.'+name+'.v1','1');
    if(value!==undefined)Object.defineProperty(HTMLMediaElement.prototype,'duration',{get:()=>value});
  },reportedDuration);
  let submissions=0;const errors=[];
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname!=='127.0.0.1')return route.abort();
    if(!url.pathname.startsWith('/browser/'))return route.continue();
    const reply=json=>route.fulfill({json});
    if(url.pathname==='/browser/health')return reply({ok:true,userId:'duration-test',processingReady:true});
    if(url.pathname==='/browser/uploads')return reply({uploadId:randomUUID(),chunkSize:8*1024*1024});
    if(url.pathname.includes('/parts/')||url.pathname.endsWith('/complete'))return reply({ok:true});
    if(url.pathname==='/browser/jobs'){submissions++;return reply({id:route.request().postDataJSON().cloudJobId,state:'processing'});}
    return reply({id:url.pathname.split('/')[3],state:'processing',resultAvailable:false});
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:5186');
  await page.locator('input[type=file]').setInputFiles(file);
  await page.waitForFunction(()=>document.querySelector('.video-stage video')?.readyState>=1);
  if(mode!=='auto')await page.getByRole('button',{name:mode==='prompt'?'文字描述（文字描述目标）':'点选目标（点选画面目标）',exact:true}).click();
  if(mode==='prompt')await page.getByLabel('要保留的对象',{exact:true}).fill('red rectangle');
  if(mode==='points')await page.locator('.video-stage video').click();
  const start=page.getByRole('button',{name:'开始抠图并导出',exact:true});
  await page.waitForFunction(()=>!document.querySelector('[data-tour=start]')?.disabled);
  return {page,start,context,errors,submissions:()=>submissions};
}
async function records(page,prefix) {
  return page.evaluate(async prefix=>(await import('/src/browser/store.ts')).list(prefix),prefix);
}
async function waitJob(page) {
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
    const jobs=await records(page,'job/');
    if(jobs[0]?.state==='failed')throw new Error(JSON.stringify(jobs[0].error));
    if(jobs.length===1&&jobs[0].state==='processing')return jobs[0];
    const errors=await page.locator('[role=alert]').allTextContents();
    if(errors.length)throw new Error(errors.join('; '));
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error('No job created: '+await page.locator('[role=alert]').allTextContents());
}
try {
  for(const mode of ['auto','prompt','points']) {
    console.log('Checking '+mode+' duration');
    const f=await fixture(mode,short);
    try {
      assert.ok(await f.page.locator('.video-stage video').evaluate(video=>video.duration)>1.1,'Fixture must expose a longer browser duration');
      await f.start.click();const job=await waitJob(f.page);
      assert.equal(job.input.start,0);assert.equal(job.input.end,1);
      await f.page.getByText('视频时长 1.00 秒，符合当前模式的 '+(mode==='auto'?60:5)+' 秒上限。',{exact:true}).waitFor();
      assert.equal((await records(f.page,'video/')).length,1);assert.deepEqual(f.errors,[]);
      console.log(mode+': full-video input uses probed duration; visible duration synchronized');
    } finally {await f.context.close();}
  }
  const manual=await fixture('prompt',boundary);
  try {
    await manual.page.getByLabel('开始（秒）',{exact:true}).fill('0.22');
    await manual.page.getByLabel('结束（秒）',{exact:true}).fill('5.22');
    await manual.start.click();
    await manual.page.getByRole('alert').filter({hasText:'裁选范围须在视频时长内'}).first().waitFor({timeout:120000});
    assert.equal(await manual.page.getByLabel('开始（秒）',{exact:true}).inputValue(),'0.22');
    assert.equal(await manual.page.getByLabel('结束（秒）',{exact:true}).inputValue(),'5.22');
    assert.equal((await records(manual.page,'job/')).length,0);assert.equal(manual.submissions(),0);
    assert.equal((await records(manual.page,'video/')).length,1);
    // Even though the corrected duration is now within the mode limit, invalid explicit controls stay visible.
    await manual.page.getByLabel('结束（秒）',{exact:true}).fill('4.75');
    await manual.start.click();const job=await waitJob(manual.page);
    assert.equal(job.input.start,.22);assert.equal(job.input.end,4.75);
    assert.equal((await records(manual.page,'video/')).length,1,'Retry must reuse the imported video');
    assert.deepEqual(manual.errors,[]);
    console.log('Manual range: strict rejection, editable corrected duration, preserved retry range and no duplicate import');
  } finally {await manual.context.close();}
  console.log('Checking newly discovered duration limit');
  const limit=await fixture('prompt',overLimit,4.9);
  try {
    console.log('Submitting video with browser duration 4.9s and video track 5.1s');
    await limit.start.click();
    await limit.page.getByText('当前模式最多处理 5 秒，请缩短裁选范围。',{exact:true}).first().waitFor({timeout:30000});
    assert.equal((await records(limit.page,'job/')).length,0);assert.equal(limit.submissions(),0);
    assert.equal(await limit.page.getByLabel('结束（秒）',{exact:true}).inputValue(),'5.1');
    await limit.page.getByLabel('结束（秒）',{exact:true}).fill('5');
    await limit.start.click();const job=await waitJob(limit.page);assert.equal(job.input.end,5);
    assert.equal((await records(limit.page,'video/')).length,1);assert.deepEqual(limit.errors,[]);
    console.log('Probe revealing an over-limit video: rejected before cloud submission; explicit correction succeeds');
  } finally {await limit.context.close();}
} finally {await browser.close();await server.close();}
