import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../dist/server/app.js';
import { createStaff, openStore } from '../dist/server/store.js';

test('counter sample and empty outlet setup provision the selected service mode without unnecessary tables', () => {
  const directory=mkdtempSync(join(tmpdir(),'restaurant-modes-'));
  try {
    for (const [name,args] of [['counter',['--demo','--mode=counter']],['outlet',['--outlet','--mode=both']]]) {
      const path=join(directory,`${name}.sqlite`);
      const setup=spawnSync(process.execPath,['dist/server/setup.js',...args],{
        env:{...process.env,RESTAURANT_DB:path},encoding:'utf8',windowsHide:true
      });
      assert.equal(setup.status,0,setup.stderr);
      const db=openStore(path);
      try {
        assert.equal(db.prepare('SELECT mode FROM outlet_settings').get().mode,name==='counter'?'counter':'both');
        assert.equal(db.prepare('SELECT count(*) AS n FROM dining_tables').get().n,0);
        assert.equal(db.prepare("SELECT count(*) AS n FROM staff WHERE role='waiter'").get().n,name==='counter'?0:2);
        assert.equal(db.prepare('SELECT count(*) AS n FROM menu').get().n,name==='counter'?4:0);
        assert.equal(db.prepare("SELECT count(*) AS n FROM staff WHERE role='admin' AND enabled=1").get().n,1);
      } finally {db.close();}
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('sample setup and the Windows-hosted process preserve orders across a service restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'restaurant-startup-'));
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    RESTAURANT_DB: join(directory, 'outlet.sqlite'),
    RESTAURANT_BIND: '127.0.0.1',
    RESTAURANT_PORT: String(port),
    RESTAURANT_ORIGIN: origin,
    RESTAURANT_TLS_KEY: '',
    RESTAURANT_TLS_CERT: ''
  };
  let service;

  function request(path, { method, headers, body } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(origin + path, { method, headers, agent: false, timeout: 5000 }, incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => resolve({
          status: incoming.statusCode,
          headers: incoming.headers,
          json: () => JSON.parse(Buffer.concat(chunks).toString())
        }));
      });
      outgoing.on('timeout', () => outgoing.destroy(new Error('Request timed out.')));
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  }

  async function start() {
    service = spawn(process.execPath, ['dist/server/main.js'], { env, windowsHide: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Restaurant service did not start.')), 10_000);
      service.once('error', error => { clearTimeout(timer); reject(error); });
      service.once('exit', code => { clearTimeout(timer); reject(new Error(`Restaurant service exited with code ${code}.`)); });
      service.stdout.on('data', chunk => {
        if (String(chunk).includes('Restaurant portal is running')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  async function stop() {
    if (service && service.exitCode === null && service.signalCode === null && service.pid) {
      const exited = once(service, 'exit');
      service.kill();
      await exited;
    }
  }

  try {
    const setup = spawnSync(process.execPath, ['dist/server/setup.js', '--demo'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(setup.status, 0, setup.stderr);
    const waiterPassword = setup.stdout.match(/^waiter\s+(\S+)$/m)?.[1];
    assert.ok(waiterPassword, 'Setup must provision a waiter.');
    const repeatedSetup = spawnSync(process.execPath, ['dist/server/setup.js', '--demo'], { env, encoding: 'utf8', windowsHide: true });
    assert.notEqual(repeatedSetup.status, 0);
    assert.match(repeatedSetup.stderr, /already has staff accounts/);

    const unsafe = spawnSync(process.execPath, ['dist/server/main.js'], {
      env: { ...env, RESTAURANT_BIND: '0.0.0.0' }, encoding: 'utf8', windowsHide: true, timeout: 5000
    });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /HTTPS origin for staff network access/);

    await start();
    const signIn = await request('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'waiter', password: waiterPassword })
    });
    assert.equal(signIn.status, 200);
    const cookie = signIn.headers['set-cookie'][0].split(';')[0];
    const placed = await request('/api/tables/1/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ requestId: randomUUID(), lines: [{ menuId: 1, quantity: 1 }] })
    });
    assert.equal(placed.status, 200);
    const { orderId } = placed.json();
    await stop();
    await start();

    const serviceState = await request('/api/service', { headers: { cookie } });
    assert.equal(serviceState.status, 200);
    const { tables } = serviceState.json();
    assert.equal(tables[0].orderId, orderId);
    assert.equal(tables[0].lines[0].name, 'Masala chai');
  } finally {
    await stop();
    rmSync(directory, { recursive: true });
  }
});

test('trusted HTTPS uses secure staff cookies', { skip: !process.env.RESTAURANT_TEST_OPENSSL }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'restaurant-tls-'));
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  const db = openStore(':memory:');
  let app;
  try {
    const cert = spawnSync(process.env.RESTAURANT_TEST_OPENSSL, [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', keyPath, '-out', certPath
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(cert.status, 0, cert.stderr);
    const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
    const password = 'test-only-tls-fixture-password';
    createStaff(db, 'waiter', 'Waiter', 'waiter', password);
    app = buildApp(db, { origin: 'https://127.0.0.1', tls });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await new Promise((resolve, reject) => {
      const request = httpsRequest(url + '/api/session', {
        method: 'POST', ca: tls.cert, agent: false, timeout: 5000,
        headers: { Host: '127.0.0.1', 'Content-Type': 'application/json' }
      }, response => {
        response.resume();
        response.on('end', () => resolve(response));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('TLS request timed out.')));
      request.end(JSON.stringify({ username: 'waiter', password }));
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Secure/);
  } finally {
    await app?.close();
    db.close();
    rmSync(directory, { recursive: true });
  }
});
