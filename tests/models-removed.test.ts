import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../apps/api/src/app.js';
import { Pipeline } from '../apps/api/src/pipeline.js';
import { Store } from '../apps/api/src/store.js';

test('removed model chain has no routes or startup recovery and keeps historical files',async t=>{
  const root=resolve('.tmp/removed-models',randomUUID()),id=randomUUID(),dir=resolve(root,'models',id);
  await mkdir(dir,{recursive:true});
  const record=JSON.stringify({id,state:'processing',renderState:'queued',requestId:'legacy-task'});
  await writeFile(resolve(dir,'record.json'),record);await writeFile(resolve(dir,'model.glb'),'historical-model');
  await writeFile(resolve(dir,'video.mp4'),'historical-video');
  const engine=new Pipeline(new Store(root),undefined);
  await engine.initialize();await engine.idle();
  const app=await createServer(engine,false);t.after(()=>app.close());
  assert.equal((await app.inject('/api/health')).json().model3dEnabled,undefined);
  for(const suffix of ['',`/${id}`,`/${id}/file`,`/${id}/video`])assert.equal((await app.inject(`/api/models${suffix}`)).statusCode,404);
  for(const suffix of ['',`/${id}/render`,`/${id}/recording`]){
    const result=await app.inject({method:'POST',url:`/api/models${suffix}`,headers:{'x-cutout-client':'1'},payload:{imageId:id}});
    assert.equal(result.statusCode,404);
  }
  assert.equal(await readFile(resolve(dir,'record.json'),'utf8'),record);
  assert.equal(await readFile(resolve(dir,'model.glb'),'utf8'),'historical-model');
  assert.equal(await readFile(resolve(dir,'video.mp4'),'utf8'),'historical-video');
});
