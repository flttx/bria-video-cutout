import { AppError } from '../../api/src/errors.js';

const MAX_LOG=1024*1024;
const events=new Set(['task_begin','task_end','task_removed','task_error','progress','response','probe_start','parallel_start','range_start','range_error','range_complete','sample','sync','fallback','merge_start','merge_complete','single_start','single_error','first_byte','single_complete']);
async function ownerKey(owner:string){const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(owner));return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}
function validate(text:string){
  const lines=text.trim().split('\n');
  if(lines.length<2||lines.length>10000)throw new AppError('LOG_INVALID','日志为空或格式无效。',400);
  for(let i=0;i<lines.length;i++){
    let row:Record<string,unknown>;try{row=JSON.parse(lines[i]!);}catch{throw new AppError('LOG_INVALID','日志格式无效。',400);}
    if(!row||typeof row!=='object'||Array.isArray(row))throw new AppError('LOG_INVALID','日志格式无效。',400);
    if(i===0){if(row.schema!==1||row.type!=='adplayer-task-diagnostics'||Object.keys(row).length!==2)throw new AppError('LOG_INVALID','日志版本不受支持。',400);continue;}
    if(Object.keys(row).some(k=>!['time','run','task','event','lane','values','dropped'].includes(k))
      ||!Number.isSafeInteger(row.time)||Number(row.time)<0||typeof row.run!=='string'||!/^[a-f0-9]{8}$/.test(row.run)
      ||typeof row.task!=='string'||!/^([a-f0-9]{12}|none)$/.test(row.task)
      ||typeof row.event!=='string'||!(events.has(row.event)||/^stage_[A-Z_]{1,32}$/.test(row.event)||/^colo_[A-Z]{3}$/.test(row.event))
      ||!Number.isInteger(row.lane)||Number(row.lane)<-1||Number(row.lane)>3
      ||!Array.isArray(row.values)||row.values.length>12||!row.values.every(v=>Number.isSafeInteger(v))
      ||(row.dropped!==undefined&&(!Number.isSafeInteger(row.dropped)||Number(row.dropped)<0)))throw new AppError('LOG_INVALID','日志字段无效。',400);
  }
}
/** Auth and same-origin checks run in browserFetch first; no public object URLs or Bria calls. */
export async function diagnostics(request:Request,owner:string,device:string,bucket:R2Bucket):Promise<Response>{
  if(!device)throw new AppError('DEVICE_REQUIRED','上传日志需要设备标识。',400);
  const identity=await ownerKey(owner),prefix='diagnostics/',path=new URL(request.url).pathname;
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  if(path==='/browser/diagnostics'&&request.method==='POST'){
    if(request.headers.get('content-type')?.split(';')[0]!=='application/x-ndjson')throw new AppError('LOG_TYPE','日志格式无效。',415);
    const length=Number(request.headers.get('content-length'));if(!Number.isSafeInteger(length)||length<1||length>MAX_LOG)throw new AppError('LOG_SIZE','日志不能超过 1 MiB。',413);
    const reader=request.body?.getReader();if(!reader)throw new AppError('LOG_INVALID','日志为空。',400);
    const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_LOG){await reader.cancel();throw new AppError('LOG_SIZE','日志不能超过 1 MiB。',413);}chunks.push(value);}}finally{reader.releaseLock();}
    if(size!==length)throw new AppError('LOG_SIZE','日志长度不匹配。',400);
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes);}catch{throw new AppError('LOG_INVALID','日志编码无效。',400);}validate(text);
    const id=crypto.randomUUID(),createdAt=Date.now();
    await bucket.put(prefix+id+'.jsonl',bytes,{httpMetadata:{contentType:'application/x-ndjson'},customMetadata:{createdAt:String(createdAt),schema:'1',owner:identity,device}});
    return Response.json({id,bytes:size,createdAt},{status:201,headers});
  }
  const match=/^\/browser\/diagnostics\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(path);
  if(match&&request.method==='GET'){
    const key=prefix+match[1]+'.jsonl',metadata=await bucket.head(key);
    if(!metadata||metadata.customMetadata?.owner!==identity||metadata.customMetadata?.device!==device)throw new AppError('NOT_FOUND','日志不存在。',404);
    const object=await bucket.get(key);if(!object)throw new AppError('NOT_FOUND','日志不存在。',404);
    return new Response(object.body,{headers:{...headers,'Content-Type':'application/x-ndjson','Content-Length':String(object.size)}});
  }
  throw new AppError('NOT_FOUND','接口不存在。',404);
}
