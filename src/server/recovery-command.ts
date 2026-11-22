import { readFileSync } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inspectEncryptedBackup, restoreInspectedBackup } from './recovery.js';

const args=process.argv.slice(2);
const values:Record<string,string>={};
for(let index=0;index<args.length;index+=2) {
  const name=args[index];const value=args[index+1];
  if(!name||!['--root','--backup','--mode','--confirm-hash','--invoice-series','--credit-series','--operator'].includes(name)
    ||value===undefined||values[name]!==undefined)throw new Error('Use the installed Restore-Backup.ps1 wrapper.');
  values[name]=value;
}
if(!values['--root']||!values['--backup']||!['review','restore'].includes(values['--mode']??'')||process.env.RESTAURANT_RECOVERY_LOCK!=='held') {
  throw new Error('Recovery requires the installed Windows wrapper with the service stopped.');
}
const root=await realpath(resolve(values['--root']));
const data=join(root,'data');
if((await lstat(data)).isSymbolicLink())throw new Error('Recovery does not accept a linked data folder.');
const config=JSON.parse(readFileSync(join(root,'settings.json'),'utf8')) as Record<string,unknown>;
const hostedConfigured=Object.entries(config).some(([name,value])=>name.startsWith('RESTAURANT_PUBLISH_')&&Boolean(value));
const scratch=join(data,'.backup-work');
await mkdir(scratch,{recursive:true,mode:0o700});
// The passphrase travels over stdin, never process arguments, settings, or logs.
const input=readFileSync(0,'utf8');
const password=input.replace(/\r?\n$/,'');
if(Buffer.byteLength(input)>4096)throw new Error('Invalid recovery passphrase input.');
const backup=await inspectEncryptedBackup(resolve(values['--backup']),password,scratch);
try {
  if(values['--mode']==='review')console.log(JSON.stringify({backup:backup.manifest,
    action:'Review this snapshot start time and hash. Restore replaces current data; later orders, payments and refunds require reconciliation. Use two previously unused financial series with the outlet stopped. Hosted recovery is blocked.'}));
  else {
    const result=await restoreInspectedBackup(backup,join(data,'outlet.sqlite'),{
      confirmHash:values['--confirm-hash']??'',invoiceSeries:values['--invoice-series']??'',creditSeries:values['--credit-series']??'',
      operator:values['--operator']??'Windows operator',hostedConfigured
    });
    console.log(JSON.stringify(result));
  }
} finally {await backup.cleanup();}
