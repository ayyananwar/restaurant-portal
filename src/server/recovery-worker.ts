import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createEncryptedBackup } from './recovery.js';
import { WorkflowError } from './store.js';

const input=workerData as {database:string;passphrase:string;scratch:string};
const database=new DatabaseSync(input.database,{readOnly:true});
try {
  database.exec('PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF;');
  const result=await createEncryptedBackup(database,input.passphrase,input.scratch);
  parentPort?.postMessage({ok:true,path:result.path,manifest:result.manifest});
}catch(error){
  parentPort?.postMessage({ok:false,status:error instanceof WorkflowError?error.statusCode:500,
    message:error instanceof WorkflowError?error.message:'The backup could not be created. Check available disk space and try again.'});
}finally{database.close();}
