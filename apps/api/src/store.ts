import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { validId } from "./model.js";

export class Store {
  constructor(readonly root: string) {}
  path(kind: "videos" | "jobs" | "exports", id: string, file = "record.json"): string {
    return join(this.root, kind, validId(id), file);
  }
  async save<T extends {id:string}>(kind: "videos" | "jobs" | "exports", value:T): Promise<void> {
    const dir = this.path(kind,value.id,"");
    await mkdir(dir,{recursive:true});
    const temp = join(dir,`${randomUUID()}.tmp`);
    await writeFile(temp,JSON.stringify(value),{mode:0o600});
    await rename(temp,this.path(kind,value.id));
  }
  async get<T>(kind:"videos"|"jobs"|"exports", id:string):Promise<T> {
    try { return JSON.parse(await readFile(this.path(kind,id),"utf8")) as T; }
    catch (e) {
      if (e instanceof AppError) throw e;
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new AppError("NOT_FOUND","未找到本地记录。",404);
      throw new AppError("STORE_ERROR","本地记录无法读取，请检查数据目录。",500);
    }
  }
  async list<T>(kind:"jobs"|"exports"):Promise<T[]> {
    await mkdir(join(this.root,kind),{recursive:true});
    const ids = (await readdir(join(this.root,kind))).filter(x=>/^[a-f0-9-]{36}$/.test(x));
    return Promise.all(ids.map(id=>this.get<T>(kind,id)));
  }
}
