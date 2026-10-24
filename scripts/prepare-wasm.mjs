import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const target=resolve(root,'apps/web/public/ffmpeg');
await mkdir(target,{recursive:true});
const core=resolve(root,'node_modules/@ffmpeg/core/dist/esm');
const wrapper=await readFile(resolve(core,'ffmpeg-core.js'),'utf8');
// Pinned 0.12.10 wrapper discards the C ffprobe return code, leaving ret=-1.
// Preserve the actual return code instead of treating failed probes as successes.
const probeCall='Module["_ffprobe"](args.length,stringsToPtr(args))';
if(wrapper.split(probeCall).length!==2)throw new Error('FFmpeg core wrapper changed; review ffprobe adapter.');
await writeFile(resolve(target,'ffmpeg-core.js'),wrapper.replace(probeCall,'Module["ret"]='+probeCall));
// Workers static assets have a per-file limit; load same-origin chunks as one WASM Blob.
const wasm=await readFile(resolve(core,'ffmpeg-core.wasm'));
const parts=[];
for(let offset=0,index=0;offset<wasm.length;offset+=8*1024*1024,index++) {
  const name=`core-${index}.bin`;parts.push(name);
  await writeFile(resolve(target,name),wasm.subarray(offset,offset+8*1024*1024));
}
await writeFile(resolve(target,'manifest.json'),JSON.stringify({version:'0.12.10',parts,bytes:wasm.length}));
console.log('Prepared same-origin FFmpeg core assets.');
