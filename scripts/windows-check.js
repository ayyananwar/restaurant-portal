import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

test('Windows bundle installs, preserves orders across restart, validates updates, and rolls back safely', { timeout: 600_000 }, async () => {
  assert.equal(process.platform, 'win32');
  assert.ok(process.env.RESTAURANT_WINDOWS_PACKAGE, 'Set RESTAURANT_WINDOWS_PACKAGE to a built installer ZIP.');
  const archive = resolve(process.env.RESTAURANT_WINDOWS_PACKAGE);
  const temporary = resolve(tmpdir());
  const lab = mkdtempSync(join(temporary, 'restaurant-installer-'));
  const payload = join(lab, 'package');
  const root = join(lab, 'Outlet installation');
  const manifestFile = join(payload, 'manifest.json');
  const script = join(payload, 'Install.ps1');
  const config = join(root, 'settings.json');
  const database = join(root, 'data', 'outlet.sqlite');
  const state = () => JSON.parse(readFileSync(join(root, 'active.json'), 'utf8'));
  const shell = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  let launcher;

  function install(...args) {
    return execFileSync('powershell.exe', [...shell, '-File', script, '-Root', root, ...args], {
      windowsHide: true, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((complete, reject) => socket.close(error => error ? reject(error) : complete()));
  const origin = `http://127.0.0.1:${port}`;

  async function start() {
    launcher = spawn('powershell.exe', [...shell, '-File', join(root, 'Launch.ps1')], { windowsHide: true, stdio: 'ignore' });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launcher.exitCode !== null) throw new Error('Installed launcher exited before serving requests.');
      const response = await fetch(origin, { signal: AbortSignal.timeout(500) }).catch(() => undefined);
      if (response?.ok) { await response.body?.cancel(); return; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error('Installed launcher did not start.');
  }

  async function stop() {
    if (!launcher?.pid || launcher.exitCode !== null) return;
    const stopped = once(launcher, 'exit');
    execFileSync('taskkill.exe', ['/PID', String(launcher.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await stopped;
  }

  try {
    execFileSync('powershell.exe', [...shell, '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:INSTALLER_TEST_ARCHIVE, $env:INSTALLER_TEST_DESTINATION)'], {
      env: { ...process.env, INSTALLER_TEST_ARCHIVE: archive, INSTALLER_TEST_DESTINATION: payload }, windowsHide: true, timeout: 90_000
    });
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, ''));
    assert.match(install('-Demo'), /Active release/);
    assert.equal(state().active, manifest.version);
    const password = readFileSync(join(root, 'data', 'demo-accounts.txt'), 'utf8').match(/^waiter\s+(\S+)$/m)?.[1];
    assert.ok(password);
    writeFileSync(config, JSON.stringify({ RESTAURANT_PORT: String(port) }));
    await start();
    const login = await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'waiter', password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const placed = await fetch(`${origin}/api/tables/1/orders`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: randomUUID(), lines: [{ menuId: 1, quantity: 2 }] }) });
    assert.equal(placed.status, 200);
    const { orderId } = await placed.json();
    const orderSurvived = async () => {
      const service = await fetch(`${origin}/api/service`, { headers: { Cookie: cookie } });
      assert.equal(service.status, 200);
      const { tables } = await service.json();
      assert.equal(tables[0].orderId, orderId);
      assert.equal(tables[0].lines[0].quantity, 2);
    };
    assert.throws(() => install(), error => /Stop the running Restaurant Portal/.test(error.stderr));
    await stop();
    await start();
    await orderSurvived();
    await stop();

    const update = manifest.version.replace(/\d+$/, patch => String(Number(patch) + 1));
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: update }));
    const index = join(payload, 'app', 'dist', 'client', 'index.html');
    const originalHtml = readFileSync(index);
    writeFileSync(index, 'tampered fixture');
    assert.throws(() => install(), error => /integrity check failed/.test(error.stderr));
    assert.equal(state().active, manifest.version);
    writeFileSync(index, originalHtml);

    assert.match(install(), /Active release/);
    assert.deepEqual(state(), { active: update, previous: manifest.version });
    await start();
    await orderSurvived();
    await stop();
    const simulatedNewerDb = new DatabaseSync(database);
    simulatedNewerDb.exec(`PRAGMA user_version = ${manifest.schema + 1}`);
    simulatedNewerDb.close();
    assert.throws(() => install('-Rollback'), error => /requires a newer application version/.test(error.stderr));
    assert.equal(state().active, update);
    const restoreFixtureVersion = new DatabaseSync(database);
    restoreFixtureVersion.exec(`PRAGMA user_version = ${manifest.schema}`);
    restoreFixtureVersion.close();
    assert.match(install('-Rollback'), /Active release/);
    assert.deepEqual(state(), { active: manifest.version, previous: update });
    await start();
    await orderSurvived();
  } finally {
    await stop();
    assert.ok(lab.startsWith(`${temporary}${sep}restaurant-installer-`));
    rmSync(lab, { recursive: true, force: true });
  }
});
