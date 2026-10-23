import { DATA_DIR } from "./env.js";
import { gatewaySettings } from "./bria/settings.js";
import { Store } from "./store.js";
import { Pipeline } from "./pipeline.js";
import { createServer } from "./app.js";

const settings=gatewaySettings(process.env);
const engine=new Pipeline(new Store(DATA_DIR),settings.selected,5000,1_800_000,settings.gateways);
const app=await createServer(engine,!!settings.selected,process.env.WEB_ORIGIN,settings.checkService);
try {
  await engine.initialize();
  const port=Number(process.env.API_PORT||3001);
  await app.listen({port,host:"127.0.0.1"});
  console.log(`Bria Cutout API listening on 127.0.0.1:${port}; ${settings.mode} service ${settings.selected?"configured":"missing"}.`);
}catch {
  console.error("API_START_FAILED: check port availability and local data permissions.");
  process.exit(1);
}
