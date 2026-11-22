import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { backup as nativeBackup, DatabaseSync } from 'node:sqlite';
import { authenticate, billableLines, checkVersion, openStore, readReceipts, submitOrder } from '../dist/server/store.js';
import { quoteBuiltInBill, recordBuiltInBill } from '../dist/server/receipt-handoff.js';
import { createEncryptedBackup, inspectEncryptedBackup, restoreInspectedBackup } from '../dist/server/recovery.js';
import { readBillingProfile, saveBillingProfile } from '../dist/server/billing.js';
import { defaultBillingProfile } from '../dist/shared/billing.js';
import { buildApp } from '../dist/server/app.js';
import { startMenuPublisher } from '../dist/server/menu-publication.js';

assert.equal(typeof nativeBackup,'function','Use the bundled runtime or Node >=22.16 for recovery tests.');
const password='fixture-only long recovery passphrase';
test('version-19 backups migrate after authentication and connector history blocks uncoordinated restore',async()=>{
  const f=fixture();
  try{
    const legacyPath=join(f.directory,'legacy.sqlite');await nativeBackup(f.db,legacyPath);
    const legacy=new DatabaseSync(legacyPath);
    legacy.exec('DROP TABLE online_decisions;DROP TABLE online_inbox;DROP TABLE online_connector;PRAGMA user_version=19;');
    const exported=await createEncryptedBackup(legacy,password,f.directory);legacy.close();
    assert.equal(exported.manifest.schema,19);
    const inspected=await inspectEncryptedBackup(exported.path,password,f.directory);
    const destination=join(f.directory,'upgraded.sqlite');
    await restoreInspectedBackup(inspected,destination,{confirmHash:inspected.manifest.sha256,invoiceSeries:'R9',creditSeries:'C9',operator:'fixture',hostedConfigured:false});
    const restored=openStore(destination);
    try{assert.equal(restored.prepare('PRAGMA user_version').get().user_version,20);assert.equal(restored.prepare('SELECT count(*) AS n FROM online_connector').get().n,1);}
    finally{restored.close();}
    await inspected.cleanup();await exported.cleanup();
    f.db.prepare('UPDATE online_connector SET destination=? WHERE id=1').run('https://fixture.example/api/publish/cafe');
    const linked=await createEncryptedBackup(f.db,password,f.directory);const linkedInspection=await inspectEncryptedBackup(linked.path,password,f.directory);
    await assert.rejects(restoreInspectedBackup(linkedInspection,join(f.directory,'blocked.sqlite'),{confirmHash:linkedInspection.manifest.sha256,
      invoiceSeries:'RA',creditSeries:'CA',operator:'fixture',hostedConfigured:false}),/coordinated recovery/);
    await linkedInspection.cleanup();await linked.cleanup();
  }finally{f.cleanup();}
});
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'restaurant-recovery-'));
  const path=join(directory,'outlet.sqlite');
  const db=openStore(path);
  for(const role of ['admin','waiter','billing','kitchen'])db.prepare('INSERT INTO staff(username,name,role,password_hash) VALUES(?,?,?,?)').run(role,role,role,'fixture');
  db.exec("INSERT INTO menu(name,price_paise,category) VALUES ('Recovery sample',12500,'Mains'); INSERT INTO dining_tables(label) VALUES ('Table 7');");
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('old-session',1,Date.now()+600_000);
  const cleanup=()=>{db.close();rmSync(directory,{recursive:true,force:true});};
  return {directory,path,db,cleanup};
}

test('encrypted snapshots restore exact data, exclude sessions, authenticate metadata and clean partial files',async()=>{
  const f=fixture();
  try {
    const exported=await createEncryptedBackup(f.db,password,f.directory);
    const bytes=readFileSync(exported.path);
    assert.equal(bytes.includes(Buffer.from('Recovery sample')),false);
    const inspected=await inspectEncryptedBackup(exported.path,password,f.directory);
    const copy=openStore(inspected.path);
    try {
      assert.equal(copy.prepare('SELECT name FROM menu').get().name,'Recovery sample');
      assert.equal(copy.prepare('SELECT count(*) AS n FROM sessions').get().n,0);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM sessions').get().n,1);
    } finally {copy.close();}
    await inspected.cleanup();
    const before=readdirSync(f.directory).sort();
    await assert.rejects(inspectEncryptedBackup(exported.path,'a wrong long passphrase',f.directory),/passphrase is incorrect/);
    assert.deepEqual(readdirSync(f.directory).sort(),before);
    for(const [name,mutate] of [
      ['ciphertext',value=>{value[value.length-20]^=1;return value;}],
      ['metadata',value=>{const index=value.indexOf(Buffer.from('"createdAt":'))+12;value[index]=value[index]===49?50:49;return value;}],
      ['truncated',value=>value.subarray(0,value.length-1)],
      ['oversized-header',value=>{value.writeUInt32BE(0xffffffff,8);return value;}]
    ]) {
      const path=join(f.directory,name+'.rpb');
      writeFileSync(path,mutate(Buffer.from(bytes)));
      await assert.rejects(inspectEncryptedBackup(path,password,f.directory));
    }
    await exported.cleanup();
    assert.equal(readdirSync(f.directory).some(name=>name.startsWith('recovery-')),false);
  } finally {f.cleanup();}
});

test('offline recovery keeps a pre-restore copy and reserves old financial series',async()=>{
  const f=fixture();
  let closed=false;
  try {
    saveBillingProfile(f.db,{id:1,name:'admin',role:'admin'},{...defaultBillingProfile,enabled:true,legalName:'Sample',address:'Ranchi'});
    const issue=(database,tableId)=>{
      const orderId=submitOrder(database,tableId,2,{requestId:crypto.randomUUID(),lines:[{menuId:1,quantity:2}]});
      const identity={orderId,splitId:null,checkNumber:1,checkVersion:checkVersion(billableLines(database,orderId))};
      const buyer={name:'',address:'',gstin:'',placeState:'20'};
      const quote=quoteBuiltInBill(database,tableId,identity,buyer,'');
      return {orderId,bill:recordBuiltInBill(database,tableId,3,{...identity,buyer,couponCode:'',requestId:crypto.randomUUID(),reviewHash:quote.reviewHash,paymentMethod:'Cash'})};
    };
    const original=issue(f.db,1);
    assert.equal(original.bill.totalPaise,25000);
    f.db.prepare('UPDATE bill_sequences SET last_number=100 WHERE series=?').run('RP');
    const exported=await createEncryptedBackup(f.db,password,f.directory);
    f.db.exec("UPDATE menu SET name='After backup'; INSERT INTO bill_sequences VALUES('LATE','2627',5); UPDATE staff SET enabled=0 WHERE role='kitchen'; UPDATE staff SET password_hash='latest-fixture-hash' WHERE role='billing';");
    f.db.close();closed=true;
    const inspected=await inspectEncryptedBackup(exported.path,password,f.directory);
    const options={confirmHash:inspected.manifest.sha256,invoiceSeries:'R2',creditSeries:'C2',operator:'Windows fixture',hostedConfigured:false};
    await assert.rejects(restoreInspectedBackup(inspected,f.path,{...options,confirmHash:'0'.repeat(64)}),/confirm its exact/);
    await assert.rejects(restoreInspectedBackup(inspected,f.path,{...options,invoiceSeries:'LATE'}),/previously unused/);
    const result=await restoreInspectedBackup(inspected,f.path,options);
    const restored=openStore(f.path);
    try {
      assert.equal(restored.prepare('SELECT name FROM menu').get().name,'Recovery sample');
      assert.equal(readBillingProfile(restored).series,'R2');
      assert.equal(readBillingProfile(restored).creditSeries,'C2');
      assert.equal(restored.prepare('SELECT count(*) AS n FROM sessions').get().n,0);
      assert.throws(()=>saveBillingProfile(restored,{id:1,name:'admin',role:'admin'},
        {...readBillingProfile(restored),series:'RP'}),/series is reserved/);
      const old=openStore(result.preserved);
      try{assert.equal(old.prepare('SELECT name FROM menu').get().name,'After backup');}finally{old.close();}
      const recovery=restored.prepare('SELECT * FROM recovery_state').get();
      assert.equal(recovery.source_hash,inspected.manifest.sha256);
      assert.equal(recovery.operator,'Windows fixture');
      assert.equal(restored.prepare("SELECT enabled FROM staff WHERE role='kitchen'").get().enabled,0);
      assert.equal(restored.prepare("SELECT password_hash FROM staff WHERE role='billing'").get().password_hash,'latest-fixture-hash');
      assert.deepEqual(readReceipts(restored,original.orderId)[0].bill,original.bill);
      assert.equal(readReceipts(restored,original.orderId)[0].paymentMethod,'Cash');
      restored.exec("INSERT INTO dining_tables(label) VALUES('Table 9'); UPDATE recovery_state SET reviewed_at=1;");
      const fresh=issue(restored,2);
      assert.match(fresh.bill.number,/^R2\/\d{4}\/000001$/);
      assert.notEqual(fresh.bill.number,original.bill.number);
    } finally {restored.close();}
    await inspected.cleanup();await exported.cleanup();
  } finally {if(!closed)f.db.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('recovery refuses a different outlet, hosted state and a missing restore directory',async()=>{
  const f=fixture();const other=fixture();
  let closed=false;
  try {
    const exported=await createEncryptedBackup(f.db,password,f.directory);
    const inspected=await inspectEncryptedBackup(exported.path,password,f.directory);
    const options={confirmHash:inspected.manifest.sha256,invoiceSeries:'R2',creditSeries:'C2',operator:'fixture',hostedConfigured:false};
    other.db.close();
    await assert.rejects(restoreInspectedBackup(inspected,other.path,options),/different outlet/);
    await assert.rejects(restoreInspectedBackup(inspected,f.path,{...options,hostedConfigured:true}),/coordinated recovery/);
    f.db.exec("UPDATE menu_publication SET destination='https://example.test/api/publish/sample'");
    f.db.close();closed=true;
    await assert.rejects(restoreInspectedBackup(inspected,f.path,options),/coordinated recovery/);
    await assert.rejects(restoreInspectedBackup(inspected,join(f.directory,'missing','outlet.sqlite'),options));
    await inspected.cleanup();await exported.cleanup();
  } finally {if(!closed)f.db.close();rmSync(f.directory,{recursive:true,force:true});rmSync(other.directory,{recursive:true,force:true});}
});

test('backup endpoint is owner-only, rejects cross-origin/invalid input and leaves live sessions valid',async()=>{
  const f=fixture();const origin='http://127.0.0.1:3100';
  const cookies={};
  for(const [index,role] of ['admin','waiter','billing','kitchen'].entries()) {
    const token=createHash('sha256').update(role).digest('hex');
    f.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),index+1,Date.now()+600_000);
    cookies[role]='staff_session='+token;
  }
  const app=buildApp(f.db,{origin});
  const request=(role,body,source=origin)=>app.inject({method:'POST',url:'/api/outlet/backup',headers:{host:'127.0.0.1:3100',origin:source,cookie:cookies[role],'content-type':'application/json'},payload:body});
  try {
    for(const role of ['waiter','billing','kitchen'])assert.equal((await request(role,{passphrase:password})).statusCode,403);
    assert.equal((await request('admin',{passphrase:password},'https://outside.test')).statusCode,403);
    assert.equal((await request('admin',{passphrase:'short'})).statusCode,400);
    const reply=await request('admin',{passphrase:password});
    assert.equal(reply.statusCode,200,reply.body.slice(0,100));
    assert.equal(reply.rawPayload.subarray(0,8).toString(),'RPORTBK1');
    assert.match(reply.headers['content-disposition'],/restaurant-backup-\d+\.rpb/);
    assert.equal((await request('admin',{passphrase:password})).statusCode,429);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM sessions').get().n,5);
    assert.equal(f.db.prepare("SELECT details FROM configuration_events WHERE action='backup-export'").get().details.includes(password),false);
    f.db.prepare('INSERT INTO recovery_state VALUES(1,?,?,?, ?,NULL)').run(Date.now(),'a'.repeat(64),'[]','fixture');
    const mutate=await app.inject({method:'POST',url:'/api/tables/1/orders',headers:{host:'127.0.0.1:3100',origin,cookie:cookies.waiter,'content-type':'application/json'},
      payload:{requestId:crypto.randomUUID(),lines:[{menuId:1,quantity:1}]}});
    assert.equal(mutate.statusCode,409,mutate.body);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM orders').get().n,0);
    const recoveryAt=f.db.prepare('SELECT restored_at FROM recovery_state').get().restored_at;
    const review=(role,sourceHash,restoredAt=recoveryAt)=>app.inject({method:'POST',url:'/api/outlet/recovery-review',headers:{host:'127.0.0.1:3100',origin,cookie:cookies[role],'content-type':'application/json'},
      payload:{sourceHash,restoredAt,confirmed:true}});
    assert.equal((await review('billing','a'.repeat(64))).statusCode,403);
    assert.equal((await review('admin','b'.repeat(64))).statusCode,409);
    assert.equal((await review('admin','a'.repeat(64),1)).statusCode,409);
    assert.equal((await review('admin','a'.repeat(64))).statusCode,204);
    assert.equal((await review('admin','a'.repeat(64))).statusCode,204);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM configuration_events WHERE action='recovery-reviewed'").get().n,1);
    const accepted=await app.inject({method:'POST',url:'/api/tables/1/orders',headers:{host:'127.0.0.1:3100',origin,cookie:cookies.waiter,'content-type':'application/json'},
      payload:{requestId:crypto.randomUUID(),lines:[{menuId:1,quantity:1}]}});
    assert.equal(accepted.statusCode,200,accepted.body);
  } finally {await app.close();f.cleanup();}
});

test('a failed final restore write keeps the original outlet and removes candidate plaintext',async()=>{
  const f=fixture();let closed=false;
  try {
    const exported=await createEncryptedBackup(f.db,password,f.directory);
    f.db.exec("UPDATE menu SET name='Current data must survive'");
    f.db.close();closed=true;
    const inspected=await inspectEncryptedBackup(exported.path,password,f.directory);
    await assert.rejects(restoreInspectedBackup(inspected,f.path,{confirmHash:inspected.manifest.sha256,invoiceSeries:'R2',creditSeries:'C2',operator:'fixture',hostedConfigured:false},
      async()=>{throw Object.assign(new Error('Injected storage exhaustion'),{code:'ENOSPC'});}),/storage exhaustion/);
    const preserved=openStore(f.path);
    try{assert.equal(preserved.prepare('SELECT name FROM menu').get().name,'Current data must survive');}finally{preserved.close();}
    await inspected.cleanup();await exported.cleanup();
    assert.equal(readdirSync(f.directory).some(name=>name.startsWith('recovery-')),false);
    assert.equal(readdirSync(f.directory).filter(name=>name.startsWith('pre-restore-')).length,1);
  }finally{if(!closed)f.db.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('installed Windows recovery wrapper reviews/restores with stdin secrets and blocks a live database', {skip:process.platform!=='win32'},async()=>{
  const f=fixture();let closed=false;
  try {
    const unicodePassword='fixture recovery secret हिन्दी 2026';
    const exported=await createEncryptedBackup(f.db,unicodePassword,f.directory);
    const root=join(f.directory,'Windows outlet');
    const app=join(root,'versions','0.4.0','app');
    mkdirSync(join(app,'runtime'),{recursive:true});mkdirSync(join(root,'data'));
    cpSync('dist/server',join(app,'dist/server'),{recursive:true});cpSync('dist/shared',join(app,'dist/shared'),{recursive:true});
    copyFileSync(process.execPath,join(app,'runtime/node.exe'));
    writeFileSync(join(app,'package.json'),'{"type":"module"}');
    copyFileSync('scripts/windows/restore.ps1',join(root,'Restore-Backup.ps1'));
    writeFileSync(join(root,'active.json'),'{"active":"0.4.0"}');writeFileSync(join(root,'settings.json'),'{}');
    f.db.close();closed=true;
    const database=join(root,'data','outlet.sqlite');copyFileSync(f.path,database);
    const command=(...extra)=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'Restore-Backup.ps1'),
      '-Root',root,'-Backup',exported.path,'-PassphraseFromStdin',...extra],{input:unicodePassword+'\n',encoding:'utf8',windowsHide:true,timeout:30_000});
    const live=openStore(database);
    const blocked=command();assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/process still has the database open/);live.close();
    const review=command();assert.equal(review.status,0,review.stderr);
    const reviewed=JSON.parse(review.stdout);
    assert.equal(reviewed.backup.sha256,exported.manifest.sha256);
    assert.equal(review.stdout.includes(unicodePassword),false);
    const restored=command('-Mode','restore','-ConfirmHash',reviewed.backup.sha256,'-InvoiceSeries','R2','-CreditSeries','C2');
    assert.equal(restored.status,0,restored.stderr);
    const data=openStore(database);
    try{assert.equal(readBillingProfile(data).series,'R2');assert.equal(data.prepare('SELECT count(*) AS n FROM sessions').get().n,0);}finally{data.close();}
    await exported.cleanup();
  }finally{if(!closed)f.db.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('hosted publishers remain paused until the owner reviews the restored outlet',async t=>{
  const f=fixture();let requests=0;
  t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(null,{status:503});});
  const target={endpoint:'https://unused.test/api/publish/sample',guestUrl:'https://unused.test/r/sample',token:'a'.repeat(64)};
  try {
    f.db.prepare('INSERT INTO recovery_state VALUES(1,?,?,?,?,NULL)').run(Date.now(),'a'.repeat(64),'[]','fixture');
    const paused=startMenuPublisher(f.db,target);
    await new Promise(resolve=>setImmediate(resolve));await paused();
    assert.equal(requests,0);
    f.db.exec('UPDATE recovery_state SET reviewed_at=1');
    const resumed=startMenuPublisher(f.db,target);
    await new Promise(resolve=>setImmediate(resolve));await resumed();
    assert.ok(requests>0);
  }finally{f.cleanup();}
});

test('missing-database recovery disables backup accounts and provisions a private fresh owner',async()=>{
  const f=fixture();
  try {
    const exported=await createEncryptedBackup(f.db,password,f.directory);
    const inspected=await inspectEncryptedBackup(exported.path,password,f.directory);
    const target=join(f.directory,'replacement.sqlite');
    const result=await restoreInspectedBackup(inspected,target,{confirmHash:inspected.manifest.sha256,invoiceSeries:'R2',creditSeries:'C2',operator:'replacement fixture',hostedConfigured:false});
    assert.ok(result.credentialsPath);
    const handoff=readFileSync(result.credentialsPath,'utf8');
    const replacement=openStore(target);
    try {
      assert.equal(replacement.prepare("SELECT count(*) AS n FROM staff WHERE enabled=1").get().n,1);
      const owner=replacement.prepare("SELECT username FROM staff WHERE role='admin' AND enabled=1").get();
      assert.match(owner.username,/^recovery-[a-f0-9]{12}$/);
      assert.ok(handoff.includes(owner.username));
      const secret=/^Password: (\S+)$/m.exec(handoff)?.[1];
      assert.ok(secret);
      assert.equal((await authenticate(replacement,owner.username,secret)).role,'admin');
      assert.equal(replacement.prepare("SELECT count(*) AS n FROM staff WHERE username IN('admin','waiter','billing','kitchen') AND enabled=1").get().n,0);
    }finally{replacement.close();}
    await inspected.cleanup();await exported.cleanup();
  }finally{f.cleanup();}
});
