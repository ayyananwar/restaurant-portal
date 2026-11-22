import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import * as sqlite from 'node:sqlite';
import { createStaff, openStore, storeSchemaVersion, WorkflowError } from './store.js';
import { readBillingProfile } from './billing.js';

const magic = Buffer.from('RPORTBK1');
const maxDatabaseBytes = 512 * 1024 * 1024;
const derive = promisify(scrypt) as (password:string,salt:Buffer,length:number,options:typeof kdf)=>Promise<Buffer>;
const kdf = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export interface BackupManifest { format: 1; createdAt: number; schema: number; bytes: number; sha256: string }

export function validateBackupPassword(password: string) {
  if (password.length < 16 || password.length > 256 || !password.trim() || /[\0\r\n]/.test(password)) {
    throw new WorkflowError(400, 'Use a backup passphrase of 16 to 256 characters. Keep it separately from the backup file.');
  }
}

async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function recoveryWorkspace(parent: string) {
  const root = await realpath(parent);
  const path = await mkdtemp(join(root, 'recovery-'));
  return { path, async cleanup() {
    // Only the scratch directory this operation created can be removed.
    if (dirname(resolve(path)) !== root || !basename(path).startsWith('recovery-')) throw new Error('Invalid recovery scratch directory.');
    await rm(path, { recursive: true, force: true });
  } };
}

function validateDatabase(path: string) {
  const database = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    database.exec('PRAGMA trusted_schema=OFF;');
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
    if (version < 19 || version > storeSchemaVersion) throw new WorkflowError(422, 'This backup requires a matching supported application version.');
    if (database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || database.prepare('PRAGMA foreign_key_check').get()) {
      throw new WorkflowError(422, 'The backup database failed its integrity checks.');
    }
    if (!database.prepare("SELECT 1 FROM staff WHERE role='admin' AND enabled=1 LIMIT 1").get()
      || !database.prepare('SELECT installation FROM offer_publication WHERE id=1').get()) {
      throw new WorkflowError(422, 'The backup does not contain a usable outlet.');
    }
    return version;
  } finally { database.close(); }
}

export async function createEncryptedBackup(database: sqlite.DatabaseSync, password: string, scratchParent: string) {
  validateBackupPassword(password);
  if (typeof sqlite.backup !== 'function') throw new WorkflowError(503, 'Backups require the bundled Windows runtime or Node 22.16 or later.');
  const estimate=Number(database.prepare('PRAGMA page_count').get()?.page_count)*Number(database.prepare('PRAGMA page_size').get()?.page_size);
  if(estimate>maxDatabaseBytes) throw new WorkflowError(413,'This outlet exceeds the 512 MB backup limit. Contact support for assisted backup.');
  const work = await recoveryWorkspace(scratchParent);
  const createdAt = Date.now();
  let key: Buffer | undefined;
  try {
    const snapshot = join(work.path, 'outlet.sqlite');
    await sqlite.backup(database, snapshot, { rate: 256 });
    const copy = new sqlite.DatabaseSync(snapshot);
    try {
      // A recovery never revives authenticated browser sessions. The live outlet is untouched.
      copy.exec('DELETE FROM sessions; PRAGMA journal_mode=DELETE; VACUUM;');
    } finally { copy.close(); }
    const schema = validateDatabase(snapshot);
    const size = (await stat(snapshot)).size;
    if (size > maxDatabaseBytes) throw new WorkflowError(413, 'This outlet exceeds the 512 MB backup limit. Contact support for assisted backup.');
    const manifest: BackupManifest = { format: 1, createdAt, schema, bytes: size, sha256: await hashFile(snapshot) };
    const metadata = Buffer.from(JSON.stringify(manifest));
    const length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const header = Buffer.concat([magic, length, metadata, salt, iv]);
    key = await derive(password, salt, 32, kdf) as Buffer;
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(header);
    const path = join(work.path, 'outlet.rpb');
    const file = await open(path, 'wx', 0o600);
    try {
      await file.write(header);
      await pipeline(createReadStream(snapshot), cipher, createWriteStream(path, { fd: file.fd, autoClose: false, start: header.length }));
      await file.write(cipher.getAuthTag(), 0, 16, header.length + size);
      await file.sync();
    } finally { await file.close(); }
    await rm(snapshot);
    return { path, manifest, cleanup: work.cleanup };
  } catch (error) { await work.cleanup(); throw error; }
  finally { key?.fill(0); }
}

export async function inspectEncryptedBackup(source: string, password: string, scratchParent: string) {
  validateBackupPassword(password);
  const size = (await stat(source)).size;
  if (size < 80 || size > maxDatabaseBytes + 8192) throw new WorkflowError(422, 'Invalid or oversized backup file.');
  const file = await open(source, 'r');
  let header: Buffer;
  let manifest: BackupManifest;
  let tag: Buffer;
  try {
    const prefix = Buffer.alloc(12);
    if ((await file.read(prefix, 0, 12, 0)).bytesRead !== 12 || !prefix.subarray(0, 8).equals(magic)) throw new Error('format');
    const metadataLength = prefix.readUInt32BE(8);
    if (metadataLength < 2 || metadataLength > 4096 || size < 12 + metadataLength + 44) throw new Error('length');
    header = Buffer.alloc(12 + metadataLength + 28);
    if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length) throw new Error('header');
    manifest = JSON.parse(header.subarray(12, 12 + metadataLength).toString('utf8')) as BackupManifest;
    if (manifest.format !== 1 || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt <= 0
      || !Number.isInteger(manifest.schema) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0
      || manifest.bytes > maxDatabaseBytes || !/^[a-f0-9]{64}$/.test(manifest.sha256)
      || size !== header.length + manifest.bytes + 16) throw new Error('manifest');
    tag = Buffer.alloc(16);
    if ((await file.read(tag, 0, 16, size - 16)).bytesRead !== 16) throw new Error('tag');
  } catch { throw new WorkflowError(422, 'The backup file is incomplete or has an unsupported format.'); }
  finally { await file.close(); }
  const work = await recoveryWorkspace(scratchParent);
  let key: Buffer | undefined;
  try {
    key = await derive(password, header.subarray(-28, -12), 32, kdf) as Buffer;
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(-12));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    const path = join(work.path, 'outlet.sqlite');
    try {
      await pipeline(createReadStream(source, { start: header.length, end: size - 17 }), decipher, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    } catch { throw new WorkflowError(422, 'The passphrase is incorrect or the backup is damaged.'); }
    // Do not open attacker-controlled plaintext as SQLite until authentication has succeeded.
    if (await hashFile(path) !== manifest.sha256 || validateDatabase(path) !== manifest.schema) {
      throw new WorkflowError(422, 'The backup contents do not match the authenticated manifest.');
    }
    return { path, manifest, cleanup: work.cleanup };
  } catch (error) { await work.cleanup(); throw error; }
  finally { key?.fill(0); }
}

export async function recoveryScratchParent(database: sqlite.DatabaseSync) {
  const file = String(database.prepare('PRAGMA database_list').get()?.file ?? '');
  if (!file) throw new WorkflowError(503, 'Backups require a persistent outlet database.');
  const parent = join(dirname(file), '.backup-work');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return parent;
}

function recoveryFacts(database: sqlite.DatabaseSync) {
  const hasConnector=Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='online_connector'").get());
  const hosted=Boolean(database.prepare('SELECT 1 FROM menu_publication WHERE destination IS NOT NULL').get()
    ||database.prepare('SELECT 1 FROM coupon_claims LIMIT 1').get()
    ||database.prepare('SELECT 1 FROM receipt_feedback_codes WHERE destination IS NOT NULL LIMIT 1').get()
    ||(hasConnector&&(database.prepare('SELECT 1 FROM online_connector WHERE destination IS NOT NULL').get()
      ||database.prepare('SELECT 1 FROM online_inbox LIMIT 1').get()||database.prepare('SELECT 1 FROM online_decisions LIMIT 1').get())));
  const series=database.prepare('SELECT DISTINCT series FROM bill_sequences').all().map(row=>String(row.series));
  const previous=database.prepare('SELECT blocked_series FROM recovery_state WHERE id=1').get();
  const profile=readBillingProfile(database);
  return { hosted,installation:String(database.prepare('SELECT installation FROM offer_publication WHERE id=1').get()?.installation),
    series:[...new Set([...series,profile.series,profile.creditSeries??'CN',...(previous?JSON.parse(String(previous.blocked_series)) as string[]:[])])] };
}

// This operation is offline only. The installed Windows wrapper holds service.lock throughout it.
// There is deliberately no HTTP restore endpoint.
export async function restoreInspectedBackup(backup: Awaited<ReturnType<typeof inspectEncryptedBackup>>, destination: string,
  options: { confirmHash:string; invoiceSeries:string; creditSeries:string; operator:string; hostedConfigured:boolean },
  publish:typeof rename=rename) {
  if(options.confirmHash!==backup.manifest.sha256) throw new WorkflowError(409,'Review the backup and confirm its exact SHA-256 before restoring.');
  if(!/^[A-Z0-9]{1,4}$/.test(options.invoiceSeries)||!/^[A-Z0-9]{1,4}$/.test(options.creditSeries)||options.invoiceSeries===options.creditSeries) {
    throw new WorkflowError(400,'Choose two distinct new invoice and credit-note series, using 1 to 4 uppercase letters or numbers.');
  }
  const target=resolve(destination);
  const parent=await realpath(dirname(target));
  const normalize=(path:string)=>process.platform==='win32'?path.toLowerCase():path;
  if(normalize(parent)!==normalize(dirname(target))) throw new WorkflowError(400,'Recovery requires a real data folder without symbolic links.');
  if(await hashFile(backup.path)!==backup.manifest.sha256)throw new WorkflowError(422,'The inspected backup changed before recovery.');
  const sourceDb=new sqlite.DatabaseSync(backup.path,{readOnly:true});
  let source:ReturnType<typeof recoveryFacts>;
  try {source=recoveryFacts(sourceDb);} finally {sourceDb.close();}
  let current:ReturnType<typeof recoveryFacts>|undefined;
  let currentStaff:Array<{id:number;username:string;name:string;role:string;password_hash:string;enabled:number}>|undefined;
  const info=await lstat(target).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(info) {
    if(!info.isFile()||info.isSymbolicLink())throw new WorkflowError(400,'The database destination must be a regular file.');
    const live=new sqlite.DatabaseSync(target,{readOnly:true});
    try {
      if(live.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new WorkflowError(422,'The current database needs assisted recovery; preserve it before proceeding.');
      const version=Number(live.prepare('PRAGMA user_version').get()?.user_version);
      if(version<19||version>storeSchemaVersion)throw new WorkflowError(422,'The installed database and backup need the same supported application version.');
      current=recoveryFacts(live);
      currentStaff=live.prepare('SELECT id,username,name,role,password_hash,enabled FROM staff ORDER BY id').all() as unknown as typeof currentStaff;
      if(!currentStaff?.some(staff=>staff.role==='admin'&&staff.enabled===1))throw new WorkflowError(422,'Current owner access needs assisted recovery.');
      if(current.installation!==source.installation)throw new WorkflowError(409,'This backup belongs to a different outlet.');
    } finally {live.close();}
  }
  if(options.hostedConfigured||source.hosted||current?.hosted)throw new WorkflowError(409,'Hosted publication or claims require coordinated recovery. Automatic restore is blocked to prevent reused coupons and stale publication.');
  const blocked=[...new Set([...source.series,...(current?.series??[])])];
  if(blocked.includes(options.invoiceSeries)||blocked.includes(options.creditSeries))throw new WorkflowError(409,'Recovery requires previously unused invoice and credit-note series.');
  if(info) {
    const live=new sqlite.DatabaseSync(target);
    try{live.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');}finally{live.close();}
  }
  for(const suffix of ['-wal','-shm']) {
    if(await stat(target+suffix).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;})) {
      throw new WorkflowError(409,'A database sidecar is still present. Stop every outlet process before recovery.');
    }
  }
  const work=await recoveryWorkspace(parent);
  let preserved:string|undefined;
  let credentialsPath:string|undefined;
  let activated=false;
  try {
    const candidate=join(work.path,'restored.sqlite');
    await copyFile(backup.path,candidate);
    if(await hashFile(candidate)!==backup.manifest.sha256)throw new WorkflowError(422,'The recovery copy failed its integrity check.');
    const restored=openStore(candidate);
    try {
      restored.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
      const profile=readBillingProfile(restored);
      restored.prepare('INSERT INTO billing_profile(id,revision,profile) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,profile=excluded.profile')
        .run(profile.revision+1,JSON.stringify({...profile,series:options.invoiceSeries,creditSeries:options.creditSeries}));
      restored.exec('DELETE FROM sessions;');
      // Revoked accounts and reset passwords must not be rolled back with the sales data.
      restored.exec('UPDATE staff SET enabled=0;');
      if(currentStaff) {
        const staff=restored.prepare(`INSERT INTO staff(id,username,name,role,password_hash,enabled) VALUES(?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET username=excluded.username,name=excluded.name,role=excluded.role,password_hash=excluded.password_hash,enabled=excluded.enabled`);
        for(const account of currentStaff)staff.run(account.id,account.username,account.name,account.role,account.password_hash,account.enabled);
      }else {
        const username='recovery-'+randomBytes(6).toString('hex');
        const password=randomBytes(24).toString('base64url');
        createStaff(restored,username,'Recovery owner','admin',password);
        credentialsPath=join(parent,`recovery-owner-${Date.now()}-${randomBytes(4).toString('hex')}.txt`);
        const credentials=await open(credentialsPath,'wx',0o600);
        try{await credentials.writeFile(`Username: ${username}\nPassword: ${password}\n\nPrivate recovery handoff. Save in a password manager, then delete this file.\n`);await credentials.sync();}
        finally{await credentials.close();}
      }
      restored.prepare('INSERT INTO recovery_state VALUES(1,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET restored_at=excluded.restored_at,source_hash=excluded.source_hash,blocked_series=excluded.blocked_series,operator=excluded.operator,reviewed_at=NULL')
        .run(Date.now(),backup.manifest.sha256,JSON.stringify(blocked),options.operator.slice(0,150));
      restored.exec('COMMIT; PRAGMA journal_mode=DELETE;');
    } finally {restored.close();}
    validateDatabase(candidate);
    const candidateFile=await open(candidate,'r+');try{await candidateFile.sync();}finally{await candidateFile.close();}
    if(info) {
      preserved=join(parent,`pre-restore-${Date.now()}-${randomBytes(6).toString('hex')}.sqlite`);
      // Keep the live pathname intact until the final atomic rename. A crash must not leave it missing.
      await copyFile(target,preserved,constants.COPYFILE_EXCL);
      const saved=await open(preserved,'r+');try{await saved.sync();}finally{await saved.close();}
    }
    await publish(candidate,target);
    activated=true;
    return {restoredAt:Date.now(),preserved,credentialsPath,invoiceSeries:options.invoiceSeries,creditSeries:options.creditSeries};
  } finally {if(!activated&&credentialsPath)await rm(credentialsPath,{force:true});await work.cleanup();}
}
