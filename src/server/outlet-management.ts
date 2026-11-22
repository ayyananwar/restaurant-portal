import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Role, Staff } from '../shared/contracts.js';
import { createStaff, hashPassword, WorkflowError } from './store.js';

export function readStaffAccounts(db: DatabaseSync) {
  return db.prepare('SELECT id,username,name,role,enabled FROM staff ORDER BY name,id').all();
}

function audit(db: DatabaseSync, actor: Staff, action: string, details: unknown) {
  db.prepare('INSERT INTO configuration_events(actor_id,at,action,details) VALUES (?,?,?,?)')
    .run(actor.id,Date.now(),action,JSON.stringify(details));
}

export function addStaffAccount(db: DatabaseSync, actor: Staff, input: { username: string; name: string; role: Role }) {
  const username = input.username.trim().toLowerCase();
  const name = input.name.trim();
  if (!name || !/^[a-z0-9_-]{1,32}$/.test(username)) throw new WorkflowError(400,'Enter a name and a username using letters, numbers, underscores or hyphens.');
  if (db.prepare('SELECT id FROM staff WHERE username=?').get(username)) throw new WorkflowError(409,'That username already exists. Use another or reset its password.');
  if (Number(db.prepare('SELECT count(*) AS n FROM staff').get()?.n) >= 1000) throw new WorkflowError(409,'This outlet reached its staff account limit.');
  const password = randomBytes(18).toString('base64url');
  createStaff(db,username,name,input.role,password);
  audit(db,actor,'staff-created',{ username,role:input.role });
  return { username,password };
}

export function updateStaffAccount(db: DatabaseSync, actor: Staff, id: number, enabled: boolean) {
  if (id === actor.id && !enabled) throw new WorkflowError(409,'Use another owner account to disable this account.');
  const account = db.prepare('SELECT role,enabled FROM staff WHERE id=?').get(id);
  if (!account) throw new WorkflowError(404,'Staff account not found.');
  if (account.role === 'admin' && !enabled && Number(db.prepare("SELECT count(*) AS n FROM staff WHERE role='admin' AND enabled=1").get()?.n) <= 1) {
    throw new WorkflowError(409,'Keep at least one enabled owner account.');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE staff SET enabled=? WHERE id=?').run(enabled?1:0,id);
    if (!enabled) db.prepare('DELETE FROM sessions WHERE staff_id=?').run(id);
    audit(db,actor,'staff-enabled',{ id,enabled });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function resetStaffPassword(db: DatabaseSync, actor: Staff, id: number) {
  if (id === actor.id) throw new WorkflowError(409,'Ask another owner account to reset your password.');
  const account = db.prepare('SELECT username FROM staff WHERE id=?').get(id);
  if (!account) throw new WorkflowError(404,'Staff account not found.');
  const password = randomBytes(18).toString('base64url');
  const hash = hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE staff SET password_hash=? WHERE id=?').run(hash,id);
    db.prepare('DELETE FROM sessions WHERE staff_id=?').run(id);
    audit(db,actor,'staff-password-reset',{ id });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { username:String(account.username), password };
}

export function saveTable(db: DatabaseSync, actor: Staff, label: string, id?: number) {
  const name = label.trim();
  if (!name) throw new WorkflowError(400,'Enter the table label.');
  const prior = db.prepare('SELECT id FROM dining_tables WHERE label=?').get(name);
  if (prior && (id === undefined || prior.id === id)) return;
  if (prior) throw new WorkflowError(409,'That table label is already in use.');
  if (id === undefined) {
    if (Number(db.prepare('SELECT count(*) AS n FROM dining_tables').get()?.n) >= 1000) throw new WorkflowError(409,'This outlet reached its table limit.');
    db.prepare('INSERT INTO dining_tables(label) VALUES (?)').run(name);
  } else if (!db.prepare('UPDATE dining_tables SET label=? WHERE id=?').run(name,id).changes) throw new WorkflowError(404,'Table not found.');
  audit(db,actor,'table-saved',{ id,label:name });
}
