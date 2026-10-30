import { DATA_DIR } from "./env.js";
import { gatewaySettings } from "./bria/settings.js";
import { Store } from "./store.js";
import { Pipeline } from "./pipeline.js";
import { createServer } from "./app.js";
import { deploymentSettings } from "./deployment.js";
import { command } from "./media.js";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tripoSettings } from './tripo.js';
import { klingSettings } from './kling.js';

try {
  const deployment=deploymentSettings(process.env);
  const settings=gatewaySettings(process.env);
  if(deployment.access) {
    await Promise.all([command("ffmpeg",["-version"],10000),command("ffprobe",["-version"],10000)]);
    await mkdir(DATA_DIR,{recursive:true});
    const check=join(DATA_DIR,`.write-check-${randomUUID()}`);
    await writeFile(check,"",{flag:"wx",mode:0o600});await unlink(check);
  }
  const tripo=tripoSettings(process.env);
  const engine=new Pipeline(new Store(DATA_DIR),settings.selected,5000,1_800_000,settings.gateways,tripo,klingSettings(process.env));
  const app=await createServer(engine,!!settings.selected,process.env.WEB_ORIGIN,settings.checkService,deployment.access);
  await engine.initialize();
  await app.listen({port:deployment.port,host:deployment.host});
  console.log(`Bria Cutout API ready; ${settings.mode} service ${settings.selected?"configured":"missing"}.`);
  for(const signal of ["SIGTERM","SIGINT"] as const)process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
}catch {
  console.error("API_START_FAILED: check deployment configuration, media tools, port and data permissions.");
  process.exit(1);
}
