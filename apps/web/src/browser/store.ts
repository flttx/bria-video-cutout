import { AppError } from '../../../api/src/errors.js';
let database:Promise<IDBDatabase>|undefined;
function db() {
  return database??=new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('bria-cutout-browser-v1',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('items');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>{database=undefined;reject(new AppError('BROWSER_STORAGE','无法打开浏览器存储，请允许此站点保存数据。',503));};
  });
}
export async function get<T>(key:string):Promise<T> {
  const database=await db();
  return new Promise((resolve,reject)=>{
    const request=database.transaction('items').objectStore('items').get(key);
    request.onsuccess=()=>request.result===undefined?reject(new AppError('NOT_FOUND','本机浏览器未保存此素材或记录，请重新选择视频。',404)):resolve(request.result as T);
    request.onerror=()=>reject(new AppError('BROWSER_STORAGE','浏览器缓存读取失败。',503));
  });
}
export async function put(key:string,value:unknown,add=false):Promise<void> {
  const database=await db();
  return new Promise((resolve,reject)=>{
    const transaction=database.transaction('items','readwrite');
    const store=transaction.objectStore('items');
    if(add)store.add(value,key);else store.put(value,key);
    transaction.oncomplete=()=>resolve();
    transaction.onabort=transaction.onerror=()=>reject(new AppError('BROWSER_STORAGE','浏览器缓存写入失败或空间不足；请释放空间后重试。',503));
  });
}
export async function list<T>(prefix:string):Promise<T[]> {
  const database=await db();
  return new Promise((resolve,reject)=>{
    const request=database.transaction('items').objectStore('items').getAll(IDBKeyRange.bound(prefix,prefix+'\uffff'));
    request.onsuccess=()=>resolve(request.result as T[]);request.onerror=()=>reject(new AppError('BROWSER_STORAGE','任务记录读取失败。',503));
  });
}
const urls=new Map<string,string>();
export async function blobUrl(key:string) {
  let url=urls.get(key);if(!url){url=URL.createObjectURL(await get<Blob>(key));urls.set(key,url);}return url;
}
