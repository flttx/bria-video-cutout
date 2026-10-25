import legacy from './legacy.js';
import { browserFetch } from './browser.js';
import type { BrowserEnv } from './browser.js';
import { tokenAuth } from './token-auth.js';
export default {
  async fetch(request:Request,env:BrowserEnv,ctx?:ExecutionContext):Promise<Response> {
    const path=new URL(request.url).pathname;
    if(path.startsWith('/auth/'))return tokenAuth(request,env);
    if(path.startsWith('/browser/'))return browserFetch(request,env,ctx);
    if(path.startsWith('/v1/'))return legacy.fetch(request,env);
    if(path.startsWith('/api/'))return Response.json({code:'LOCAL_API_REMOVED',message:'请刷新页面使用浏览器处理模式。'},{status:410});
    if(!env.ASSETS)return new Response('Frontend assets not built.',{status:503});
    return env.ASSETS.fetch(request);
  },
};
