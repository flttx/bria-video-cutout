import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { createServer } from 'vite';

test('web proxy preserves upload bytes and returned media URLs with direct and gateway routing',async()=>{
  const password='synthetic-proxy-regression-password';
  const auth='Basic '+Buffer.from('admin:'+password).toString('base64');
  const seen:{url:string;auth:string|undefined;range:string|undefined;body:Buffer}[]=[];
  const upstream=createHttpServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    seen.push({url:req.url!,auth:req.headers.authorization,range:req.headers.range,body:Buffer.concat(chunks)});
    if(req.headers.authorization!==auth){res.writeHead(401).end();return;}
    if(req.method==='POST'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({downloadUrl:'/api/exports/example/file'}));return;}
    if(req.headers.range){res.writeHead(206,{'Content-Range':'bytes 1-3/5','Content-Type':'video/mp4'}).end(Buffer.from([2,3,4]));return;}
    res.writeHead(200,{'Content-Type':'video/mp4','Content-Disposition':'attachment; filename="sample.mp4"'}).end(Buffer.from([1,2,3,4,5]));
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const address=upstream.address();assert.ok(address&&typeof address==='object');
  const settings={CUTOUT_API_BASE_URL:`http://127.0.0.1:${address.port}`,CUTOUT_API_USERNAME:'admin',CUTOUT_API_PASSWORD:password,CUTOUT_API_PATH_PREFIX:''};
  const previous=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));
  try {
    for(const prefix of ['', '/bria-cutout']) {
      Object.assign(process.env,settings,{CUTOUT_API_PATH_PREFIX:prefix});
      const web=await createServer({root:resolve('apps/web'),configFile:resolve('apps/web/vite.config.ts'),mode:'server',logLevel:'silent',server:{host:'127.0.0.1',port:0,strictPort:true}});
      try {
        await web.listen();const bound=web.httpServer!.address();assert.ok(bound&&typeof bound==='object');
        const base=`http://127.0.0.1:${bound.port}`;seen.length=0;
        const bytes=Buffer.from([0,1,128,255]);
        const upload=await fetch(base+'/bria-cutout/api/videos',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Cutout-Client':'1'},body:bytes});
        assert.equal(upload.status,200);const video=await upload.json() as {downloadUrl:string};
        const ranged=await fetch(base+'/bria-cutout'+video.downloadUrl,{headers:{Range:'bytes=1-3'}});
        assert.equal(ranged.status,206);assert.equal(ranged.headers.get('content-range'),'bytes 1-3/5');
        assert.deepEqual(Buffer.from(await ranged.arrayBuffer()),Buffer.from([2,3,4]));
        const download=await fetch(base+'/bria-cutout'+video.downloadUrl+'?download=1');
        assert.match(download.headers.get('content-disposition')!,/^attachment/);
        assert.equal((await download.arrayBuffer()).byteLength,5);
        assert.deepEqual(seen.map(item=>item.url),[prefix+'/api/videos',prefix+video.downloadUrl,prefix+video.downloadUrl+'?download=1']);
        assert.ok(seen.every(item=>item.auth===auth));assert.deepEqual(seen[0].body,bytes);assert.equal(seen[1].range,'bytes=1-3');
      } finally {await web.close();}
    }
  } finally {
    for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));
  }
});
