import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { downloadFile } from '../apps/api/src/bria/client.js';

const url='https://example.com/result?signature=synthetic-private';
async function output(){const dir=resolve('.tmp/download-recovery',randomUUID());await mkdir(dir,{recursive:true});return resolve(dir,'result.bin');}

test('result GET reconnects after connect/reset failures and replaces partial output atomically',async()=>{
  const file=await output();await writeFile(file,'previous-complete');let calls=0;
  await downloadFile(url,file,async(_url,init)=>{
    assert.equal(init?.method,undefined);assert.equal(await readFile(file,'utf8'),'previous-complete');
    calls++;
    if(calls===1)throw new TypeError('synthetic-private',{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});
    if(calls===2){let reads=0;return new Response(new ReadableStream({pull(controller){if(reads++===0)controller.enqueue(new TextEncoder().encode('partial'));else controller.error(Object.assign(new Error('synthetic-private'),{code:'ECONNRESET'}));}}));}
    return new Response('complete-new-result');
  });
  assert.equal(calls,3);assert.equal(await readFile(file,'utf8'),'complete-new-result');
  await assert.rejects(stat(file+'.part'),{code:'ENOENT'});
});

test('expired and oversized results are not retried; repeated resets stop after three GETs',async t=>{
  t.mock.method(console,'warn',()=>{});
  for(const mode of ['expired','oversized','reset']){
    const file=await output();let calls=0;
    await assert.rejects(downloadFile(url,file,async()=>{
      calls++;if(mode==='reset')throw Object.assign(new Error('synthetic-private'),{code:'ECONNRESET'});
      return mode==='expired'?new Response(null,{status:403}):new Response('too-large');
    },3),error=>{assert.ok(error instanceof Error);assert.ok(!error.message.includes('synthetic-private'));return true;});
    assert.equal(calls,mode==='reset'?3:1);await assert.rejects(stat(file+'.part'),{code:'ENOENT'});
  }
});

test('stalled body is aborted by the stream deadline even when transport ignores the signal',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});t.mock.method(console,'warn',()=>{});
  const file=await output();let calls=0,cancelled=0;
  await assert.rejects(downloadFile(url,file,async()=>{
    calls++;
    return new Response(new ReadableStream({pull(){t.mock.timers.tick(120001);},cancel(){cancelled++;}}));
  }));
  assert.equal(calls,3);assert.equal(cancelled,3);await assert.rejects(stat(file+'.part'),{code:'ENOENT'});
});
