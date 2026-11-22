// Private-network sample installation. No production database or Windows trust-store changes.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { resolve, join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const match = /^--(address|release|openssl|development)=(.+)$/.exec(value);
  if (!match) throw new Error('Use --address=IPv4 with --release=version or --development=true [--openssl=executable].');
  return [match[1], match[2]];
}));
const address = args.address;
const development = args.development === 'true';
const version = development ? 'development' : args.release;
if ((args.development !== undefined && !development) || (development && args.release)) throw new Error('Choose one tested release or the development build.');
if (process.platform !== 'win32' || isIP(address ?? '') !== 4 || (!development && !/^\d+\.\d+\.\d+$/.test(version ?? ''))) {
  throw new Error('Supply the current trusted Windows Wi-Fi IPv4 address and a tested release version.');
}
if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) throw new Error('Use a private-network address.');
const root = resolve('data/phone-pilot');
const packageDirectory = join(root, `release-${version}`);
const appDirectory = development ? resolve('.') : join(packageDirectory, 'app');
const node = development ? resolve('data/windows-runtime/node-v22.23.4-win-x64/node.exe') : join(appDirectory, 'runtime/node.exe');
const openssl = args.openssl ?? 'C:/Program Files/Git/usr/bin/openssl.exe';
const origin = `https://${address}:3443`;
mkdirSync(root, { recursive: true });
function run(executable, parameters, options = {}) {
  const result = spawnSync(executable, parameters, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(`Lab setup failed (${executable}): ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
// Keys, account passwords and sample data are private to this Windows user and SYSTEM.
const username = run('whoami.exe', []).trim();
run('icacls.exe', [root, '/inheritance:r', '/grant:r', `${username}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F']);
if (!existsSync(node)) {
  if (development) throw new Error('The development phone lab requires the validated bundled Windows runtime.');
  const archive = resolve(`dist/windows/restaurant-portal-${version}-win-x64.zip`);
  const expected = readFileSync(`${archive}.sha256`, 'utf8').trim().toUpperCase();
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex').toUpperCase();
  if (actual !== expected) throw new Error('The release archive checksum did not match.');
  // Paths are passed as environment values, never interpolated into PowerShell code.
  run('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:PHONE_LAB_ARCHIVE -DestinationPath $env:PHONE_LAB_DESTINATION'], {
    env: { ...process.env, PHONE_LAB_ARCHIVE: archive, PHONE_LAB_DESTINATION: packageDirectory }
  });
}
if (development && !existsSync(join(appDirectory, 'dist/server/main.js'))) throw new Error('Build the development app before starting the phone lab.');
const caKey = join(root, 'ca.key');
const ca = join(root, 'restaurant-phone-lab.crt');
if (!existsSync(ca)) {
  run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30',
    '-subj', '/CN=Restaurant Portal Phone Lab', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', ca]);
}
const key = join(root, 'server.key');
const cert = join(root, 'server.crt');
const csr = join(root, 'server.csr');
const extensions = join(root, 'server.ext');
writeFileSync(extensions, `subjectAltName=IP:${address}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
run(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=Restaurant Portal Phone Lab Server', '-keyout', key, '-out', csr]);
run(openssl, ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '14', '-sha256', '-extfile', extensions, '-out', cert]);
const database = join(root, 'sample.sqlite');
const env = { ...process.env, RESTAURANT_DB: database, RESTAURANT_BIND: address, RESTAURANT_PORT: '3443',
  RESTAURANT_ORIGIN: origin, RESTAURANT_TLS_KEY: key, RESTAURANT_TLS_CERT: cert, RESTAURANT_SAMPLE_ARTWORK: '1',
  RESTAURANT_PUBLISH_ORIGIN: '', RESTAURANT_PUBLISH_OUTLET: '', RESTAURANT_PUBLISH_TOKEN: '', RESTAURANT_QR_PREVIEW_URL: '' };
if (!existsSync(database)) {
  const credentials = run(node, ['dist/server/setup.js', '--demo', '--mode=both'], { cwd: appDirectory, env });
  writeFileSync(join(root, 'accounts.txt'), credentials);
}
// One public certificate only. This is not a directory/file server; private keys are never served.
const certificateBytes = readFileSync(ca);
const download = createServer((incoming, outgoing) => {
  if (incoming.method !== 'GET' || incoming.url !== '/restaurant-phone-lab.crt' || incoming.headers.host !== `${address}:3444`) {
    outgoing.writeHead(404).end();
    return;
  }
  outgoing.writeHead(200, { 'content-type': 'application/x-x509-ca-cert',
    'content-disposition': 'attachment; filename="restaurant-phone-lab.crt"',
    'content-length': certificateBytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  outgoing.end(certificateBytes);
});
await new Promise((accept, reject) => { download.once('error', reject); download.listen(3444, address, accept); });
const service = spawn(node, ['dist/server/main.js'], { cwd: appDirectory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
service.stdout.on('data', bytes => process.stdout.write(bytes));
service.stderr.on('data', bytes => process.stderr.write(bytes));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  download.close();
  service.kill();
}
service.on('error', error => { console.error(error.message); process.exitCode = 1; stop(); });
service.on('exit', code => { if (!stopping) { process.exitCode = code || 1; stop(); } });
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
async function health() {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (stopping) throw new Error('The lab server stopped during startup.');
    try {
      await new Promise((accept, reject) => {
        const check = request(`${origin}/`, { ca: certificateBytes, timeout: 2000 }, response => {
          response.resume();
          response.statusCode === 200 ? accept() : reject(new Error(`HTTP ${response.statusCode}`));
        });
        check.once('error', reject);
        check.once('timeout', () => check.destroy(new Error('Health check timeout.')));
        check.end();
      });
      return;
    } catch { await new Promise(accept => setTimeout(accept, 300)); }
  }
  throw new Error('The encrypted lab endpoint did not become ready.');
}
try {
  await health();
  writeFileSync(join(root, 'connection.json'), JSON.stringify({ origin, certificateUrl: `http://${address}:3444/restaurant-phone-lab.crt`,
    certificateSha256: createHash('sha256').update(certificateBytes).digest('hex'), pid: process.pid, servicePid: service.pid, version }, null, 2));
  console.log(`Phone lab ready: ${origin}\nPublic certificate: http://${address}:3444/restaurant-phone-lab.crt\nPrivate sample accounts: data/phone-pilot/accounts.txt`);
} catch (error) { stop(); throw error; }
