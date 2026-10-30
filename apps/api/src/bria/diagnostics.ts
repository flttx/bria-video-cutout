import { AppError } from '../errors.js';

export interface BriaCallDiagnostic {
  operation:'upload'|'media_upload'|'media_download'|'remove_background'|'mask_by_prompt'|'mask_by_key_points'|'status'|'unknown';
  stage:'network'|'http'|'decode'|'validate';
  elapsedMs:number;
  httpStatus?:number;
  networkCode?:string;
}
const networkCodes=new Set(['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','ECONNRESET','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','ERR_TLS_HANDSHAKE_TIMEOUT','ABORT_ERR']);
// Never serialize raw errors, messages, stacks, headers, request bodies or signed URLs.
export function safeNetworkCode(error:unknown,depth=0):string|undefined {
  if(depth>3||!error||typeof error!=='object')return undefined;
  const value=error as {code?:unknown;name?:unknown;cause?:unknown;errors?:unknown};
  if(typeof value.code==='string'&&networkCodes.has(value.code))return value.code;
  if(value.name==='TimeoutError')return 'REQUEST_TIMEOUT';
  if(value.name==='AbortError')return 'ABORT_ERR';
  const cause=safeNetworkCode(value.cause,depth+1);if(cause)return cause;
  if(Array.isArray(value.errors))for(const child of value.errors.slice(0,8)){const code=safeNetworkCode(child,depth+1);if(code)return code;}
  return undefined;
}
export function briaOperation(path:string):BriaCallDiagnostic['operation'] {
  if(path.startsWith('/status/'))return 'status';
  const known:Record<string,BriaCallDiagnostic['operation']>={
    '/video/upload':'upload','/video/edit/remove_background':'remove_background',
    '/video/segment/mask_by_prompt':'mask_by_prompt','/video/segment/mask_by_key_points':'mask_by_key_points',
  };
  return known[path]??'unknown';
}
export class BriaCallError extends AppError {
  constructor(code:string,message:string,readonly diagnostic:BriaCallDiagnostic) {
    super(code,message,502);
    console.warn(JSON.stringify({event:'bria.request_failed',code,...diagnostic}));
  }
}
