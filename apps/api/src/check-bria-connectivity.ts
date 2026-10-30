import './env.js';
import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { safeNetworkCode } from './bria/diagnostics.js';

// Read-only probe: a random status ID never submits a processing or upload request.
const hostname='engine.prod.bria-api.com';
try {
  console.log(JSON.stringify({event:'bria.connectivity_dns',addresses:await lookup(hostname,{all:true})}));
  const token=process.env.BRIA_API_TOKEN?.trim();
  if(!token)throw new Error('TOKEN_MISSING');
  for(let attempt=1;attempt<=3;attempt++) {
    const started=Date.now();
    try {
      const response=await fetch(`https://${hostname}/v2/status/${randomUUID()}`,{headers:{api_token:token},redirect:'manual',signal:AbortSignal.timeout(15000)});
      console.log(JSON.stringify({event:'bria.connectivity_probe',attempt,status:response.status,elapsedMs:Date.now()-started}));
      await response.body?.cancel();
      if(![200,404].includes(response.status))process.exitCode=1;
    } catch(error) {
      console.log(JSON.stringify({event:'bria.connectivity_probe',attempt,elapsedMs:Date.now()-started,networkCode:safeNetworkCode(error)??'UNKNOWN_NETWORK_ERROR'}));process.exitCode=1;
    }
  }
} catch(error) {
  console.error(JSON.stringify({event:'bria.connectivity_unavailable',networkCode:safeNetworkCode(error)??'CHECK_CONFIG_OR_DNS'}));process.exitCode=1;
}
