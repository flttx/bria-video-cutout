import test from 'node:test';
import assert from 'node:assert/strict';
import { BriaHttpClient, BriaHttpError } from '../apps/api/src/bria/protocol.js';
import { BriaCallError, safeNetworkCode } from '../apps/api/src/bria/diagnostics.js';

test('network diagnostics classify failures without leaking credentials, URLs or retrying a submission',async t=>{
  const logs:string[]=[];t.mock.method(console,'warn',(line:string)=>logs.push(line));
  const secret='private-token-for-diagnostic-test',url='https://private.invalid/video?signature=private-signature';
  let calls=0;
  const client=new BriaHttpClient(secret,async()=>{calls++;throw new TypeError(secret+' '+url,{cause:Object.assign(new Error(url),{code:'UND_ERR_CONNECT_TIMEOUT'})});});
  await assert.rejects(client.autoForeground(url),error=>{
    assert.ok(error instanceof BriaCallError);assert.equal(error.code,'BRIA_NETWORK');
    assert.equal(error.diagnostic.networkCode,'UND_ERR_CONNECT_TIMEOUT');assert.equal(error.diagnostic.operation,'remove_background');return true;
  });
  assert.equal(calls,1);assert.equal(logs.length,1);
  assert.ok(!logs[0].includes(secret));assert.ok(!logs[0].includes('private.invalid'));assert.ok(!logs[0].includes('private-signature'));
  assert.deepEqual(Object.keys(JSON.parse(logs[0])).sort(),['code','elapsedMs','event','networkCode','operation','stage'].sort());
  assert.equal(safeNetworkCode({code:url,cause:{code:'ENOTFOUND'}}),'ENOTFOUND');
  assert.equal(safeNetworkCode({code:url,message:secret}),undefined);
});

test('upstream HTTP and response failures remain distinguishable without logging response bodies',async t=>{
  const logs:string[]=[];t.mock.method(console,'warn',(line:string)=>logs.push(line));
  const responses=[
    {response:()=>new Response('private-upstream-detail',{status:503}),stage:'http',status:503},
    {response:()=>new Response('private-not-json',{status:202}),stage:'decode',status:202},
    {response:()=>Response.json({url:'https://private.invalid/?signature=secret'},{status:202}),stage:'validate',status:undefined},
  ];
  for(const item of responses){let count=0;const client=new BriaHttpClient('secret',async()=>{count++;return item.response();});
    await assert.rejects(client.autoForeground('https://input.invalid'),error=>{assert.ok(error instanceof BriaCallError);assert.equal(error.diagnostic.stage,item.stage);assert.equal(error.diagnostic.httpStatus,item.status);if(item.stage==='http')assert.ok(error instanceof BriaHttpError);return true;});assert.equal(count,1);
  }
  assert.equal(logs.length,3);assert.ok(!logs.join('').includes('private'));assert.ok(!logs.join('').includes('signature'));
});
