import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DATA_DIR } from './env.js';
import { AppError, object, publicError } from './errors.js';
import { MAX_BYTES, exportOptions } from './model.js';
import { command, probe, render, validateArtifact } from './media.js';

// Only local media operations: no Bria calls, credential forwarding or caller-selected paths.
export async function createNativeServer(root=join(DATA_DIR,'native'),extraOrigin?:string) {
  const app=Fastify({logger:false,bodyLimit:2*MAX_BYTES,requestTimeout:1_800_000});
  const origins=new Set(['localhost','127.0.0.1'].flatMap(host=>[5173,5174,5175].map(port=>`http://${host}:${port}`)));
  if(extraOrigin&&/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(extraOrigin))origins.add(extraOrigin);
  // ponytail: one native render at a time bounds CPU/disk pressure; add a durable queue only if needed.
  let busy=false;
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
    if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host??'')||
      request.headers.origin&&!origins.has(request.headers.origin)||request.headers['sec-fetch-site']==='cross-site')
      throw new AppError('ORIGIN_REJECTED','仅允许本机页面使用原生处理服务。',403);
    if(request.headers['x-cutout-client']!=='1')throw new AppError('CLIENT_HEADER_REQUIRED','请求缺少本地客户端标识。',403);
  });
  app.setErrorHandler((error,_request,reply)=>{
    reply.code(error instanceof AppError?error.statusCode:500).send(publicError(error));
  });
  app.addContentTypeParser('application/octet-stream',(_request,payload,done)=>done(null,payload));
  app.get('/native/health',async()=>{
    await Promise.all([command('ffmpeg',['-version'],10000),command('ffprobe',['-version'],10000)]);
    return {ok:true,service:'cutout-native',version:1};
  });
  app.post('/native/render',async(request,reply)=>{
    if(busy)throw new AppError('NATIVE_BUSY','本机正在合成另一段视频，请稍后恢复任务。',409);
    if(!(request.body instanceof Readable))throw new AppError('INVALID_UPLOAD','需要二进制视频数据。',415);
    let raw:unknown;
    try{raw=JSON.parse(String(request.headers['x-cutout-render']??''));}catch{throw new AppError('INVALID_RENDER','合成参数无效。');}
    const params=object(raw),options=exportOptions(params);
    const sourceBytes=params.sourceBytes,kind=params.kind;
    if(typeof sourceBytes!=='number'||!Number.isSafeInteger(sourceBytes)||sourceBytes<1||sourceBytes>MAX_BYTES||!['alpha','mask','direct'].includes(String(kind)))
      throw new AppError('INVALID_RENDER','合成参数无效。');
    const declared=Number(request.headers['content-length']);
    if(Number.isFinite(declared)&&(declared<=sourceBytes||declared>sourceBytes+MAX_BYTES))throw new AppError('UPLOAD_SIZE','素材大小超过限制或内容为空。',413);
    busy=true;
    let folder:string|undefined;
    try {
      await mkdir(root,{recursive:true});folder=await mkdtemp(join(root,'render-'));
      const source=join(folder,'source'),artifact=join(folder,'artifact'),output=join(folder,'output.mp4');
      const sourceFile=await open(source,'wx',0o600);
      try {
        const artifactFile=await open(artifact,'wx',0o600);
        try {
          let received=0;
          for await(const data of request.body) {
            const chunk=Buffer.from(data as Uint8Array);
            if(received+chunk.length>sourceBytes+MAX_BYTES)throw new AppError('UPLOAD_SIZE','素材大小超过限制。',413);
            const split=Math.min(chunk.length,Math.max(0,sourceBytes-received));
            if(split)await sourceFile.writeFile(chunk.subarray(0,split));
            if(split<chunk.length)await artifactFile.writeFile(chunk.subarray(split));
            received+=chunk.length;
          }
          if(received<=sourceBytes)throw new AppError('INVALID_UPLOAD','素材数据不完整。');
        }finally{await artifactFile.close();}
      }finally{await sourceFile.close();}
      // Probe files locally; never trust client-supplied dimensions, frame counts or filter strings.
      const meta=await probe(source,true);
      if(meta.duration>60.001)throw new AppError('DURATION_LIMIT','本地合成片段不能超过 60 秒。');
      const type=kind as 'alpha'|'mask'|'direct';
      await validateArtifact(artifact,meta,type);
      const result=await render(source,artifact,type,output,options,meta);
      reply.header('X-Cutout-Result',JSON.stringify(result)).header('Content-Length',result.bytes).type('video/mp4');
      await reply.send(createReadStream(output));
    }finally{
      try{if(folder)await rm(folder,{recursive:true,force:true});}finally{busy=false;}
    }
  });
  return app;
}
