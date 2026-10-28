import { createNativeServer } from './native.js';
const app=await createNativeServer();
try {
  await app.listen({port:3002,host:'127.0.0.1'});
  console.log('Native FFmpeg service listening on 127.0.0.1:3002.');
}catch {
  console.error('NATIVE_START_FAILED: check port availability and local data permissions.');process.exit(1);
}
