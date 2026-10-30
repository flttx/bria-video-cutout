import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from 'node:timers/promises';
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { validId } from "./model.js";
type StoreKind = "videos" | "jobs" | "exports" | "images" | "image-jobs" | "image-videos";

export class Store {
  constructor(readonly root: string) {}
  path(kind: StoreKind, id: string, file = "record.json"): string {
    return join(this.root, kind, validId(id), file);
  }
  async save<T extends {id:string}>(kind: StoreKind, value:T): Promise<void> {
    const dir = this.path(kind,value.id,"");
    await mkdir(dir,{recursive:true});
    const temp = join(dir,`${randomUUID()}.tmp`);
    await writeFile(temp,JSON.stringify(value),{mode:0o600});
    try {
      // Windows readers may briefly deny replacement. Retry only the local atomic rename,
      // never the work that produced this record (which may include a paid API call).
      for(let attempt=0;;attempt++) {
        try {await rename(temp,this.path(kind,value.id));break;}
        catch(error) {
          if(process.platform!=='win32'||attempt>=5||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))throw error;
          await delay(20*(attempt+1));
        }
      }
    }finally{await rm(temp,{force:true});}
  }
  async get<T>(kind:StoreKind, id:string):Promise<T> {
    try { return JSON.parse(await readFile(this.path(kind,id),"utf8")) as T; }
    catch (e) {
      if (e instanceof AppError) throw e;
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new AppError("NOT_FOUND","未找到本地记录。",404);
      throw new AppError("STORE_ERROR","本地记录无法读取，请检查数据目录。",500);
    }
  }
  async list<T>(kind:"jobs"|"exports"|"image-jobs"|"image-videos"):Promise<T[]> {
    await mkdir(join(this.root,kind),{recursive:true});
    const ids = (await readdir(join(this.root,kind))).filter(x=>/^[a-f0-9-]{36}$/.test(x));
    return Promise.all(ids.map(id=>this.get<T>(kind,id)));
  }
}
