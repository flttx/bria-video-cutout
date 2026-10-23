import test, {before, after, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {readFile,mkdir,copyFile} from "node:fs/promises";
import {resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {Miniflare, convertV4MiniflareOptions} from "miniflare";
import {CloudBriaClient} from "../../api/src/bria/cloud.js";
import {gatewaySettings} from "../../api/src/bria/settings.js";
import {Pipeline} from "../../api/src/pipeline.js";
import {Store} from "../../api/src/store.js";
import {command,probe} from "../../api/src/media.js";
import {createServer} from "../../api/src/app.js";
import type {JobRecord,VideoRecord,ExportRecord} from "../../api/src/model.js";

const token="local-test-credential-not-a-real-secret-123456";
let mf:Miniflare,db:Awaited<ReturnType<Miniflare["getD1Database"]>>;
let submissions=0,queries=0,uploads=0,submitCode=202,statusCode=200,malformed=false;
let completed=false,warning=false,lastBody:Record<string,unknown>={},hold:Promise<void>|undefined;
const meta={width:320,height:180,duration:1,fps:24,frames:24};
const root=resolve(".tmp/cloud-tests",randomUUID());
const source=resolve(root,"source.mp4"),mask=resolve(root,"mask.mp4"),alpha=resolve(root,"alpha.webm");
before(async()=>{
  await mkdir(root,{recursive:true});
  await command("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=320x180:r=24:d=1","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=1","-vf","drawbox=x=100:y=30:w=100:h=120:color=red:t=fill","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest",source]);
  await command("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=white:s=320x180:r=24:d=1","-c:v","libx264","-pix_fmt","yuv420p",mask]);
  await command("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=320x180:r=24:d=1","-vf","drawbox=x=100:y=30:w=100:h=120:color=red:t=fill,format=rgba,colorkey=blue:0.1:0.0","-c:v","libvpx-vp9","-pix_fmt","yuva420p","-auto-alt-ref","0",alpha]);
});
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:"apps/worker/dist/index.js",compatibilityDate:"2026-07-30",d1Databases:["DB"],
    bindings:{BRIA_API_TOKEN:"fake-upstream-token",CUTOUT_CLOUD_TOKEN:token},
    outboundService:async(request)=>{
      const url=new URL(request.url);
      assert.equal(url.origin,"https://engine.prod.bria-api.com","No external request may leave the test");
      assert.equal(request.headers.get("api_token"),"fake-upstream-token");
      if(url.pathname==="/v2/video/upload") {
        uploads++;
        return Response.json({result:{upload_url:"https://example.com/upload?private=upload",upload_fields:{key:"source.mp4",policy:"private-policy"},file_url:"https://example.com/source?private=file"}});
      }
      if(url.pathname.startsWith("/v2/status/")) {
        queries++;if(hold)await hold;
        if(statusCode!==200)return new Response("private upstream error",{status:statusCode,headers:{"Retry-After":"30"}});
        return Response.json({status:completed?"COMPLETED":"IN_PROGRESS",...(completed?{result:{mask_url:"https://example.com/result?private=mask",video_url:"https://example.com/result?private=video",...(warning?{warning:"private warning URL"}:{}),private_debug:"secret"}}:{})});
      }
      assert.ok(["/v2/video/edit/remove_background","/v2/video/segment/mask_by_prompt","/v2/video/segment/mask_by_key_points"].includes(url.pathname));
      submissions++;lastBody=await request.json() as Record<string,unknown>;if(hold)await hold;
      if(submitCode!==202)return new Response("private rejection details",{status:submitCode});
      return Response.json(malformed?{private_debug:"secret"}:{request_id:`bria-request-${submissions}`,status_url:"https://untrusted.invalid/status"},{status:202});
    }}));
  db=await mf.getD1Database("DB");
  const sql=await readFile("apps/worker/migrations/0001_tasks.sql","utf8");
  for(const statement of sql.split(";").filter(s=>s.trim()))await db.prepare(statement).run();
});
after(async()=>{await mf?.dispose();});
beforeEach(async()=>{
  await db.prepare("DELETE FROM jobs").run();await db.prepare("DELETE FROM uploads").run();
  submissions=0;queries=0;uploads=0;submitCode=202;statusCode=200;malformed=false;completed=false;warning=false;lastBody={};hold=undefined;
});
function call(path:string,body?:unknown,headers:Record<string,string>={}) {
  return mf.dispatchFetch("https://cloud.example"+path,{method:body===undefined?"GET":"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",...headers},body:body===undefined?undefined:JSON.stringify(body)});
}
async function input(extra:Record<string,unknown>={}) {
  const response=await call("/v1/uploads",{});assert.equal(response.status,201,await response.clone().text());
  const grant=await response.json() as {uploadId:string};
  return {cloudJobId:randomUUID(),uploadId:grant.uploadId,mode:"prompt",prompt:"person",meta,...extra};
}
async function waitUntil(predicate:()=>boolean) {
  const end=Date.now()+3000;while(!predicate()){assert.ok(Date.now()<end,"Mock request did not arrive");await new Promise(r=>setTimeout(r,10));}
}
async function due(id:string) {await db.prepare("UPDATE jobs SET next_poll_at=0 WHERE id=?").bind(id).run();}

test("health requires authentication, blocks browser origins and never contacts Bria",async()=>{
  assert.equal((await call("/v1/health",undefined,{Authorization:"Bearer wrong"})).status,401);
  assert.equal((await call("/v1/health",undefined,{Origin:"http://localhost:5174"})).status,403);
  const response=await call("/v1/health");assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal(submissions+queries+uploads,0);
  assert.equal(response.headers.get("access-control-allow-origin"),null);
});
test("uploads remain JSON only; validation fails before any paid submission",async()=>{
  const job=await input();
  for(const extra of [{video:"https://evil.invalid"},{meta:{...meta,duration:6,frames:144}},{meta:{...meta,height:751}},{mode:"points",prompt:undefined,frame_index:24,key_points:[{x:0,y:0,type:"positive"}]},{mode:"points",prompt:undefined,frame_index:0,key_points:[{x:320,y:0,type:"positive"}]},{mode:"auto",prompt:undefined,color:"#fff"}]) {
    assert.equal((await call("/v1/jobs",{...job,...extra})).status,400);
  }
  assert.equal((await call("/v1/jobs",{...job,prompt:"x".repeat(70000)})).status,413);
  await db.prepare("UPDATE uploads SET expires_at=0").run();
  assert.equal((await call("/v1/jobs",job)).status,410);assert.equal(submissions,0);
});
test("concurrent identical submissions reserve one paid call and conflicting parameters return 409",async()=>{
  const job=await input();let release!:()=>void;hold=new Promise(r=>{release=r;});
  const first=call("/v1/jobs",job);
  await waitUntil(()=>submissions>0);
  const duplicate=await call("/v1/jobs",job);assert.equal(duplicate.status,202);assert.equal((await duplicate.json() as {state:string}).state,"submitting");
  assert.equal((await call("/v1/jobs",{...job,prompt:"another"})).status,409);
  release();assert.equal((await first).status,202);hold=undefined;
  assert.equal((await call("/v1/jobs",job)).status,202);assert.equal(submissions,1);
});
test("three modes preserve documented body defaults and pixel/frame mapping",async()=>{
  for(const extra of [{mode:"auto",prompt:undefined},{mode:"auto",prompt:undefined,color:"Blue"},{},{mode:"points",prompt:undefined,frame_index:12,key_points:[{x:319,y:179,type:"positive"}]}]) {
    const job=await input(extra);assert.equal((await call("/v1/jobs",job)).status,202);
    assert.equal(lastBody.video,"https://example.com/source?private=file");
    if(job.mode==="auto") {assert.equal(lastBody.auto_zoom,false);assert.equal(lastBody.preserve_audio,true);assert.equal(lastBody.background_color,"color" in job?job.color:"Transparent");assert.equal(lastBody.output_container_and_codec,"color" in job?"mp4_h264":"webm_vp9");}
    else assert.equal(lastBody.auto_trim,false);
    if(job.mode==="points"){assert.equal(lastBody.frame_index,12);assert.deepEqual(lastBody.key_points,[{x:319,y:179,type:"positive"}]);}
  }
  assert.equal(submissions,4);
});
test("poll lease deduplicates concurrent requests, terminal response is cached and sanitized",async()=>{
  const job=await input();await call("/v1/jobs",job);
  await call(`/v1/jobs/${job.cloudJobId}`);assert.equal(queries,0);
  await due(job.cloudJobId);completed=true;warning=true;
  let release!:()=>void;hold=new Promise(r=>{release=r;});
  const first=call(`/v1/jobs/${job.cloudJobId}`);await waitUntil(()=>queries>0);
  assert.equal((await call(`/v1/jobs/${job.cloudJobId}`)).status,200);assert.equal(queries,1);
  release();const response=await first;hold=undefined;
  const text=await response.text();assert.ok(!text.includes("private_debug")&&!text.includes("private warning")&&!text.includes("bria-request"));
  const result=JSON.parse(text);assert.equal(result.state,"completed");assert.equal(result.status.result.warning,true);
  await call(`/v1/jobs/${job.cloudJobId}`);assert.equal(queries,1);assert.equal(submissions,1);
});
test("429 polling backs off in D1 without resubmission",async()=>{
  const job=await input();await call("/v1/jobs",job);await due(job.cloudJobId);statusCode=429;
  const response=await call(`/v1/jobs/${job.cloudJobId}`);assert.equal(response.status,502);assert.ok(!(await response.text()).includes("private"));
  const row=await db.prepare("SELECT next_poll_at FROM jobs WHERE id=?").bind(job.cloudJobId).first<{next_poll_at:number}>();
  assert.ok(row!.next_poll_at>Date.now()+25000);
  await call(`/v1/jobs/${job.cloudJobId}`);assert.equal(queries,1);assert.equal(submissions,1);
});
test("known rejection stays rejected; malformed, timeout and 5xx submissions remain uncertain",async()=>{
  for(const code of [403,408,500,202]) {
    submitCode=code;malformed=code===202;
    const job=await input();const response=await call("/v1/jobs",job);
    assert.equal((await response.json() as {state:string}).state,code===403?"rejected":"uncertain");
    const count=submissions;await call("/v1/jobs",job);await call(`/v1/jobs/${job.cloudJobId}`);assert.equal(submissions,count);
  }
});
test("database failure before reservation prevents submission; after acceptance leaves a non-reclaimable reservation",async()=>{
  const job=await input();
  await db.prepare("CREATE TRIGGER fail_insert BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'private database error'); END").run();
  try {const response=await call("/v1/jobs",job);assert.equal(response.status,503);assert.ok(!(await response.text()).includes("private"));assert.equal(submissions,0);}
  finally {await db.prepare("DROP TRIGGER fail_insert").run();}
  await db.prepare("CREATE TRIGGER fail_accept BEFORE UPDATE OF request_id ON jobs BEGIN SELECT RAISE(ABORT, 'private database error'); END").run();
  try {assert.equal((await call("/v1/jobs",job)).status,503);assert.equal(submissions,1);}
  finally {await db.prepare("DROP TRIGGER fail_accept").run();}
  await db.prepare("UPDATE jobs SET created_at=0 WHERE id=?").bind(job.cloudJobId).run();
  const recovered=await call(`/v1/jobs/${job.cloudJobId}`);assert.equal((await recovered.json() as {state:string}).state,"uncertain");
  await call("/v1/jobs",job);assert.equal(submissions,1);
});
test("a missing upstream request is terminal and never creates a replacement",async()=>{
  const job=await input();await call("/v1/jobs",job);await due(job.cloudJobId);statusCode=404;
  const response=await call(`/v1/jobs/${job.cloudJobId}`);assert.equal((await response.json() as {state:string}).state,"failed");
  await call(`/v1/jobs/${job.cloudJobId}`);assert.equal(queries,1);assert.equal(submissions,1);
});

async function localFixture(options:{lostResponse?:boolean;expiredResult?:boolean;ambiguous?:boolean}={}) {
  const store=new Store(resolve(root,randomUUID()));
  const video:VideoRecord={id:randomUUID(),meta:await probe(source),bytes:(await readFile(source)).length,createdAt:new Date().toISOString(),filename:"test.mp4"};
  await store.save("videos",video);await copyFile(source,store.path("videos",video.id,"source"));
  let mediaUploads=0,lost=options.lostResponse;
  const transport:typeof fetch=async(url,init)=>{
    const path=new URL(String(url)).pathname;
    if(path.startsWith("/v1/jobs/"))await due(path.split("/").at(-1)!);
    const response=await mf.dispatchFetch(String(url),{method:init?.method,headers:init?.headers as Record<string,string>,body:init?.body as string|undefined});
    if(path==="/v1/jobs"&&lost){lost=false;await response.body?.cancel();throw new Error("simulated lost response");}
    return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});
  };
  const mediaTransport:typeof fetch=async(url,init)=>{
    assert.equal(new URL(String(url)).origin,"https://example.com");
    const headers=new Headers(init?.headers);assert.equal(headers.get("api_token"),null);assert.equal(headers.get("authorization"),null);
    if(init?.method==="POST") {
      mediaUploads++;assert.ok(init.body instanceof FormData);
      const file=init.body.get("file");assert.ok(file instanceof Blob);assert.ok(file.size>0);
      return new Response(null,{status:204});
    }
    if(options.expiredResult)return new Response(null,{status:403});
    const path=String(url).includes("private=mask")?mask:lastBody.background_color==="Transparent"?alpha:source;
    return new Response(await readFile(path));
  };
  const cloud=new CloudBriaClient("https://cloud.example",token,transport,mediaTransport);
  const engine=new Pipeline(store,cloud,1,3000);
  const input={id:randomUUID(),videoId:video.id,mode:"prompt",prompt:"person",points:[],start:0,end:1,color:"White",resolution:"source",reusable:true};
  completed=true;malformed=!!options.ambiguous;
  return {store,cloud,engine,input,video,mediaUploads:()=>mediaUploads};
}
test("local cloud pipeline uploads directly, exports all modes with audio and recolors cached artifacts",async()=>{
  for(const extra of [{mode:"auto"},{mode:"auto",reusable:false},{},{mode:"points",points:[{x:1,y:1,type:"positive",atSeconds:0.5}]}]) {
    const f=await localFixture();await f.engine.create({...f.input,...extra});await f.engine.idle();
    const job=await f.store.get<JobRecord>("jobs",f.input.id);assert.equal(job.state,"completed",JSON.stringify(job.error));assert.equal(job.transport,"cloud");
    const output=await f.store.get<ExportRecord>("exports",f.input.id);assert.equal(output.meta?.width,320);assert.equal(output.meta?.frames,24);assert.equal(output.meta?.hasAudio,true);
    if(extra.mode==="points"){assert.equal(lastBody.frame_index,12);assert.deepEqual(lastBody.key_points,[{x:319,y:179,type:"positive"}]);}
    const count=submissions,exportId=randomUUID();
    if(extra.reusable===false)await assert.rejects(f.engine.createExport(job.id,{id:exportId,color:"Blue"}),/未缓存透明/);
    else {await f.engine.createExport(job.id,{id:exportId,color:"Blue"});await f.engine.idle();assert.equal((await f.store.get<ExportRecord>("exports",exportId)).state,"completed");}
    assert.equal(submissions,count);assert.equal(f.mediaUploads(),1);
    const app=await createServer(f.engine,true,undefined,()=>f.cloud.health());
    assert.equal((await app.inject({url:"/api/health"})).statusCode,200);
    const publicResponse=await app.inject({url:`/api/jobs/${job.id}`});
    for(const secret of [token,"private=",job.cloudJobId!,"requestId","cloudJobId"])assert.ok(!publicResponse.body.includes(secret));
    assert.equal((await app.inject({url:`/api/exports/${job.id}/file`,headers:{range:"bytes=0-15"}})).statusCode,206);
    await app.close();
  }
});
test("lost cloud submission response recovers through D1 lookup after restart without reupload or resubmit",async()=>{
  const f=await localFixture({lostResponse:true});await f.engine.create(f.input);await f.engine.idle();
  let job=await f.store.get<JobRecord>("jobs",f.input.id);assert.equal(job.state,"failed");assert.equal(job.canResume,true);assert.ok(job.cloudJobId);assert.equal(job.requestId,undefined);
  const restarted=new Pipeline(f.store,f.cloud,1,3000);await restarted.resume(job.id);await restarted.idle();
  job=await f.store.get<JobRecord>("jobs",job.id);assert.equal(job.state,"completed",JSON.stringify(job.error));assert.equal(submissions,1);assert.equal(f.mediaUploads(),1);
});
test("confirmed rejection creates a new cloud attempt only on explicit resume",async()=>{
  const f=await localFixture();submitCode=403;await f.engine.create(f.input);await f.engine.idle();
  let job=await f.store.get<JobRecord>("jobs",f.input.id);const previous=job.cloudJobId;
  assert.equal(job.error?.code,"CLOUD_SUBMISSION_REJECTED");assert.equal(job.canResume,true);assert.equal(submissions,1);
  const restarted=new Pipeline(f.store,f.cloud,1,3000);await restarted.initialize();await restarted.idle();assert.equal(submissions,1);
  submitCode=202;await restarted.resume(job.id);await restarted.idle();job=await f.store.get<JobRecord>("jobs",job.id);
  assert.equal(job.state,"completed",JSON.stringify(job.error));assert.notEqual(job.cloudJobId,previous);assert.equal(submissions,2);
});
test("ambiguous cloud acceptance and expired results never become automatic paid retries",async()=>{
  for(const options of [{ambiguous:true},{expiredResult:true}]) {
    const f=await localFixture(options);const count=submissions;await f.engine.create(f.input);await f.engine.idle();
    const job=await f.store.get<JobRecord>("jobs",f.input.id);assert.equal(job.state,"failed");assert.equal(job.canResume,false);
    assert.equal(job.error?.code,options.ambiguous?"SUBMISSION_UNCERTAIN":"RESULT_EXPIRED");
    await assert.rejects(f.engine.resume(job.id));assert.equal(submissions,count+1);
  }
});
test("transport is pinned per job, missing old gateway fails explicitly, cached exports work offline",async()=>{
  const f=await localFixture({lostResponse:true});await f.engine.create(f.input);await f.engine.idle();
  const restart=new Pipeline(f.store,undefined,1,3000,{cloud:f.cloud});await restart.resume(f.input.id);await restart.idle();
  let job=await f.store.get<JobRecord>("jobs",f.input.id);assert.equal(job.state,"completed");
  const offline=new Pipeline(f.store,undefined,1,3000);const exportId=randomUUID();await offline.createExport(job.id,{id:exportId,color:"Blue"});await offline.idle();assert.equal((await f.store.get<ExportRecord>("exports",exportId)).state,"completed");
  // A legacy task has no transport field; cloud selection must not send it to D1.
  job={...job,state:"queued",artifactReady:false};delete job.transport;await f.store.save("jobs",job);
  const switched=new Pipeline(f.store,f.cloud,1,3000);await switched.initialize();await switched.idle();job=await f.store.get<JobRecord>("jobs",job.id);
  assert.equal(job.error?.code,"SERVICE_NOT_CONFIGURED");assert.equal(submissions,1);
});
test("cloud configuration never silently falls back to direct credentials",async()=>{
  const settings=gatewaySettings({BRIA_TRANSPORT:"cloud",BRIA_API_TOKEN:"fake-direct-token"});assert.equal(settings.selected,undefined);await assert.rejects(settings.checkService!());
  assert.throws(()=>gatewaySettings({BRIA_TRANSPORT:"typo"}));
  assert.throws(()=>new CloudBriaClient("http://remote.example",token));assert.throws(()=>new CloudBriaClient("https://user:pass@remote.example",token));
  assert.equal(gatewaySettings({BRIA_API_TOKEN:"fake-direct-token"}).mode,"direct");
  const client=new CloudBriaClient("http://127.0.0.1:8787",token,async()=>Response.json({code:"evil",message:"private signed URL"},{status:503}));
  await assert.rejects(client.health(),error=>error instanceof Error&&!error.message.includes("private"));
  const f=await localFixture();const app=await createServer(f.engine,false,undefined,settings.checkService);
  const health=await app.inject({url:"/api/health"});assert.equal(health.statusCode,200);assert.equal(health.json().processingReady,false);await app.close();
});
