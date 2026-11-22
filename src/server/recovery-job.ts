import { dirname, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { recoveryScratchParent, recoveryWorkspace, validateBackupPassword, type BackupManifest } from './recovery.js';
import { WorkflowError } from './store.js';

export async function createBackupJob(database:DatabaseSync,passphrase:string) {
  validateBackupPassword(passphrase);
  const source=String(database.prepare('PRAGMA database_list').get()?.file??'');
  if(!source)throw new WorkflowError(503,'Backups require a persistent outlet database.');
  const work=await recoveryWorkspace(await recoveryScratchParent(database));
  try {
    const worker=new Worker(new URL('./recovery-worker.js',import.meta.url),{workerData:{database:source,passphrase,scratch:work.path}});
    const result=await new Promise<{path:string;manifest:BackupManifest}>((accept,reject)=>{
      let message:{ok:boolean;path:string;manifest:BackupManifest;status:number;message:string}|undefined;
      let failure:Error|undefined;
      const timeout=setTimeout(()=>{failure=new WorkflowError(503,'The backup took too long. Check available disk space and contact support.');void worker.terminate();},120_000);
      timeout.unref();
      worker.once('message',value=>{message=value;});
      worker.once('error',()=>{failure=new WorkflowError(500,'The backup worker stopped unexpectedly. Retry or contact support.');});
      // Wait for exit before handing off or deleting files; Windows may still hold worker handles.
      worker.once('exit',code=>{
        clearTimeout(timeout);
        if(failure)return reject(failure);
        if(code!==0||!message)return reject(new WorkflowError(500,'The backup worker did not complete.'));
        if(!message.ok)return reject(new WorkflowError(message.status,message.message));
        const path=resolve(message.path);
        const normalize=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
        if(!normalize(dirname(path)).startsWith(normalize(work.path+sep)))return reject(new Error('Invalid backup worker output.'));
        accept({path,manifest:message.manifest});
      });
    });
    return {...result,cleanup:work.cleanup};
  }catch(error){await work.cleanup();throw error;}
}
