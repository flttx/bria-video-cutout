import Fastify from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { Transform, Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { AppError, publicError } from "./errors.js";
import { PUBLIC_CONFIG } from "./config.js";
import { MAX_BYTES, validId } from "./model.js";
import type { VideoRecord, JobRecord, ExportRecord } from "./model.js";
import { compatiblePreview, createThumbnail, probe } from "./media.js";
import { Pipeline, jobView, exportView } from "./pipeline.js";
import { verifyProxyToken, verifyBasicAuth } from "./deployment.js";
import type { ServerAccess } from "./deployment.js";
import { registerImageRoutes } from './images.js';
import { registerImageVideoRoutes } from './image-videos.js';

export async function createServer(engine:Pipeline, tokenConfigured:boolean, extraOrigin?:string, checkService?:()=>Promise<void>, access?:ServerAccess) {
  const app=Fastify({logger:false,bodyLimit:64*1024,requestTimeout:600000});
  const origins=new Set(access?[access.origin]:["http://localhost:5173","http://127.0.0.1:5173","http://localhost:5174","http://127.0.0.1:5174",...(extraOrigin?[extraOrigin]:[])]);
  if(!access)await app.register(cors,{origin:[...origins]});
  if(access?.mode==="basic")await app.register(cors,{
    origin:[...origins],methods:["GET","POST","OPTIONS"],
    allowedHeaders:["Authorization","Content-Type","X-Cutout-Client","X-Video-Filename","Range"],
    exposedHeaders:["Content-Disposition","Content-Length","Content-Range","Accept-Ranges"],
    maxAge:600,
  });
  app.addHook("onRequest",async(request,reply)=>{
    reply.header("Cache-Control","no-store").header("X-Content-Type-Options","nosniff");
    if(access) {
      if(access.mode==="basic") {
        try {verifyBasicAuth(request.headers.authorization,access.proxyToken);}
        catch(error){reply.header("WWW-Authenticate",'Basic realm="Cutout API", charset="UTF-8"');throw error;}
        // Native apps send no Origin. Browser mutations must carry the exact allowed Origin.
        if(!request.headers.origin&&request.method==="POST"&&request.headers["sec-fetch-site"]!==undefined)throw new AppError("ORIGIN_REJECTED","浏览器请求缺少有效来源。",403);
      } else {
        verifyProxyToken(request.headers["x-cutout-proxy-token"],access.proxyToken);
        if(request.headers["sec-fetch-site"]==="cross-site" || (request.method==="POST"&&request.headers.origin!==access.origin))throw new AppError("ORIGIN_REJECTED","请从本站页面发起请求。",403);
      }
    }
    if(request.headers.origin&&!origins.has(request.headers.origin))throw new AppError("ORIGIN_REJECTED","不允许此来源访问本地服务。",403);
    if(request.method==="POST"&&request.headers["x-cutout-client"]!=="1")throw new AppError("CLIENT_HEADER_REQUIRED","请求缺少本地客户端标识。",403);
  });
  app.setErrorHandler((error,_request,reply)=>{
    const known=error instanceof AppError;
    const code=(error as {code?:string}).code;
    const badJson=code==="FST_ERR_CTP_INVALID_JSON_BODY"||code==="FST_ERR_CTP_EMPTY_JSON_BODY";
    const tooLarge=code==="FST_ERR_CTP_BODY_TOO_LARGE";
    reply.code(known?error.statusCode:badJson?400:tooLarge?413:500).send(known?publicError(error):badJson?{code:"INVALID_JSON",message:"请求 JSON 无效。"}:tooLarge?{code:"BODY_TOO_LARGE",message:"请求超过大小上限。"}:publicError(error));
  });
  app.addContentTypeParser("application/octet-stream",(request,payload,done)=>{
    const path=request.url.split('?')[0]!;
    if(request.method!=="POST"||!["/api/videos","/api/images"].includes(path)) {done(new AppError("INVALID_CONTENT_TYPE","此接口不接受二进制请求。",415));return;}
    done(null,payload);
  });
  app.get("/api/health",async()=>{
    let processingReady=tokenConfigured;
    if(checkService)try{await checkService();}catch{processingReady=false;}
    // Cloud failure must not disable local previews, downloads or cached re-exports.
    return {ok:true,service:"bria-cutout-api",phase:"pipeline",tokenConfigured,processingReady,imageWhiteEnabled:engine.images.available,imageWhiteProviders:engine.images.providers,klingVideoEnabled:engine.imageVideos.available};
  });
  app.get("/api/config",async()=>PUBLIC_CONFIG);
  registerImageRoutes(app,engine.images);
  registerImageVideoRoutes(app,engine.imageVideos);
  app.post("/api/videos",async(request,reply)=>{
    if(!(request.body instanceof Readable))throw new AppError("INVALID_UPLOAD","请以二进制流上传视频。",415);
    const declared=Number(request.headers["content-length"]);
    if(Number.isFinite(declared)&&declared>MAX_BYTES)throw new AppError("UPLOAD_TOO_LARGE","视频不能超过 1 GB。",413);
    const id=randomUUID(),folder=engine.store.path("videos",id,"");
    await mkdir(folder,{recursive:true});
    let bytes=0;
    const limit=new Transform({transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;callback(bytes>MAX_BYTES?new AppError("UPLOAD_TOO_LARGE","视频不能超过 1 GB。",413):null,chunk);}});
    try {
      const path=engine.store.path("videos",id,"source");
      await streamPipeline(request.body,limit,createWriteStream(path,{mode:0o600}));
      if(!bytes)throw new AppError("EMPTY_FILE","视频文件为空。");
      const meta=await probe(path);
      const header=request.headers["x-video-filename"];
      let filename=typeof header==="string"?header:"video.mp4";
      try { filename=decodeURIComponent(filename); } catch { filename="video.mp4"; }
      filename=filename.replace(/[\\/\0-\x1f\x7f]/g,"_").slice(-160)||"video.mp4";
      const video:VideoRecord={id,meta,bytes,createdAt:new Date().toISOString(),filename};
      await engine.store.save("videos",video);
      return reply.code(201).send(video);
    }catch(e){await rm(folder,{recursive:true,force:true});throw e;}
  });
  async function describeJob(job:JobRecord) {
    let video:VideoRecord|undefined;
    try {video=await engine.store.get<VideoRecord>("videos",job.input.videoId);}
    catch(error) {if(!(error instanceof AppError)||error.code!=="NOT_FOUND")throw error;}
    return {...jobView(job),filename:video?.filename,videoDuration:video?.meta.duration,thumbnailUrl:`/api/jobs/${job.id}/thumbnail`};
  }
  app.post("/api/jobs",async(request,reply)=>reply.code(202).send(await describeJob(await engine.create(request.body))));
  app.get("/api/jobs",async()=>{
    const jobs=(await engine.store.list<JobRecord>("jobs")).filter(job=>!job.removedAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50);
    const exports=(await engine.store.list<ExportRecord>("exports")).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return Promise.all(jobs.map(async job=>{const related=exports.filter(item=>item.jobId===job.id);const latest=related.find(item=>item.state==="completed")??related[0];return {...await describeJob(job),latestExport:latest?exportView(latest):undefined,latestAttempt:related[0]?exportView(related[0]):undefined};}));
  });
  app.get<{Params:{id:string}}>("/api/jobs/:id",async(request)=>describeJob(await engine.store.get<JobRecord>("jobs",validId(request.params.id))));
  app.post<{Params:{id:string}}>("/api/jobs/:id/remove",async(request,reply)=>{await engine.setHistoryRemoved(request.params.id,true);return reply.send({ok:true});});
  app.post<{Params:{id:string}}>("/api/jobs/:id/undo-remove",async(request,reply)=>{await engine.setHistoryRemoved(request.params.id,false);return reply.send({ok:true});});
  app.get<{Params:{id:string}}>("/api/jobs/:id/thumbnail",async(request,reply)=>{
    const job=await engine.store.get<JobRecord>("jobs",validId(request.params.id));
    const latest=(await engine.store.list<ExportRecord>("exports")).filter(item=>item.jobId===job.id&&item.state==="completed").sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
    const video=latest?undefined:await engine.store.get<VideoRecord>("videos",job.input.videoId);
    const source=latest?engine.store.path("exports",latest.id,"output.mp4"):engine.store.path("videos",video!.id,"source");
    const thumbnail=latest?engine.store.path("exports",latest.id,"thumbnail.jpg"):engine.store.path("jobs",job.id,"source-thumbnail.jpg");
    await createThumbnail(source,thumbnail,latest?.meta?.duration??video!.meta.duration);
    const size=(await stat(thumbnail)).size;
    return reply.type("image/jpeg").header("Content-Length",size).send(createReadStream(thumbnail));
  });
  app.post<{Params:{id:string}}>("/api/jobs/:id/resume",async(request,reply)=>reply.code(202).send(await describeJob(await engine.resume(request.params.id))));
  app.post<{Params:{id:string}}>("/api/jobs/:id/export",async(request,reply)=>reply.code(202).send(exportView(await engine.createExport(request.params.id,request.body))));
  app.get<{Params:{id:string}}>("/api/videos/:id",async(request)=>{
    const video=await engine.store.get<VideoRecord>("videos",validId(request.params.id));
    return {id:video.id,meta:video.meta,filename:video.filename??"video.mp4",bytes:video.bytes};
  });
  app.get<{Params:{id:string}}>("/api/videos/:id/file",async(request,reply)=>{
    const video=await engine.store.get<VideoRecord>("videos",validId(request.params.id));
    const file=engine.store.path("videos",video.id,"source"),size=(await stat(file)).size;
    const extension=(video.filename??"video.mp4").toLowerCase().split(".").pop();
    const contentType=extension==="mov"?"video/quicktime":extension==="webm"?"video/webm":extension==="avi"?"video/x-msvideo":extension==="gif"?"image/gif":"video/mp4";
    reply.type(contentType).header("Accept-Ranges","bytes");
    let start=0,end=size-1;
    if(request.headers.range) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if(!match||(!match[1]&&!match[2]))return reply.code(416).header("Content-Range",`bytes */${size}`).send();
      if(!match[1])start=Math.max(0,size-Number(match[2]));
      else {start=Number(match[1]);if(match[2])end=Math.min(size-1,Number(match[2]));}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size)return reply.code(416).header("Content-Range",`bytes */${size}`).send();
      reply.code(206).header("Content-Range",`bytes ${start}-${end}/${size}`);
    }
    return reply.header("Content-Length",end-start+1).send(createReadStream(file,{start,end}));
  });
  app.post<{Params:{id:string}}>("/api/videos/:id/preview",async(request,reply)=>{
    const video=await engine.store.get<VideoRecord>("videos",validId(request.params.id));
    const source=engine.store.path("videos",video.id,"source"),preview=engine.store.path("videos",video.id,"preview.mp4");
    try {await stat(preview);}catch {await compatiblePreview(source,preview,video.meta);}
    return reply.code(200).send({id:video.id,meta:video.meta});
  });
  app.get<{Params:{id:string}}>("/api/videos/:id/preview",async(request,reply)=>{
    const file=engine.store.path("videos",validId(request.params.id),"preview.mp4"),size=(await stat(file)).size;
    reply.type("video/mp4").header("Accept-Ranges","bytes");
    let start=0,end=size-1;
    if(request.headers.range) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if(!match||(!match[1]&&!match[2]))return reply.code(416).header("Content-Range",`bytes */${size}`).send();
      if(!match[1])start=Math.max(0,size-Number(match[2]));
      else {start=Number(match[1]);if(match[2])end=Math.min(size-1,Number(match[2]));}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size)return reply.code(416).header("Content-Range",`bytes */${size}`).send();
      reply.code(206).header("Content-Range",`bytes ${start}-${end}/${size}`);
    }
    return reply.header("Content-Length",end-start+1).send(createReadStream(file,{start,end}));
  });
  app.get<{Params:{id:string}}>("/api/exports/:id",async(request)=>exportView(await engine.store.get<ExportRecord>("exports",validId(request.params.id))));
  app.get<{Params:{id:string};Querystring:{download?:string}}>("/api/exports/:id/file",async(request,reply)=>{
    const item=await engine.store.get<ExportRecord>("exports",validId(request.params.id));
    if(item.state!=="completed")throw new AppError("NOT_READY","文件尚未完成导出。",409);
    const file=engine.store.path("exports",item.id,"output.mp4"),size=(await stat(file)).size;
    reply.type("video/mp4").header("Accept-Ranges","bytes").header("Content-Disposition",`${request.query.download==="1"?"attachment":"inline"}; filename="cutout-${item.resolution}-${item.color}-${item.id.slice(0,8)}.mp4"`);
    let start=0,end=size-1;
    if(request.headers.range) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if(!match||(!match[1]&&!match[2]))return reply.code(416).header("Content-Range",`bytes */${size}`).send();
      if(!match[1])start=Math.max(0,size-Number(match[2]));
      else {start=Number(match[1]);if(match[2])end=Math.min(size-1,Number(match[2]));}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size)return reply.code(416).header("Content-Range",`bytes */${size}`).send();
      reply.code(206).header("Content-Range",`bytes ${start}-${end}/${size}`);
    }
    return reply.header("Content-Length",end-start+1).send(createReadStream(file,{start,end}));
  });
  return app;
}
