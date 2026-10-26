import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { createHandler } from '../server/app.js';
import { decryptFile, encryptFile, encodeKey, signV4 } from '../server/backup.js';

const PASS = 'mango lassi at four';
let dir, backupDir, server, base, store, owner, cashier;
let s3, s3Url, s3Requests = [];
let dav, davUrl, davRequests = [];

async function call(path, method = 'GET', body, token = owner) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hisaab-test-'));
  backupDir = join(dir, 'backups');

  // A fake S3 that checks the signature exactly as AWS would, from the request as received.
  s3 = createServer(async (req, res) => {
    const body = await readBody(req);
    const auth = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,SignedHeaders=([^,]+),Signature=([0-9a-f]+)/.exec(req.headers.authorization ?? '');
    const amz = req.headers['x-amz-date'];
    const date = new Date(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`);
    const extra = Object.fromEntries(auth[4].split(';').filter((h) => !['host', 'x-amz-date', 'x-amz-content-sha256'].includes(h)).map((h) => [h, req.headers[h]]));
    const expected = signV4({ method: req.method, host: req.headers.host, path: req.url, headers: extra, payloadHash: createHash('sha256').update(body).digest('hex'),
      accessKey: auth[1], secretKey: 'test-secret-key', region: auth[3], date });
    const ok = auth[1] === 'AKTEST' && expected.authorization === req.headers.authorization
      && req.headers['x-amz-content-sha256'] === createHash('sha256').update(body).digest('hex');
    s3Requests.push({ url: req.url, ok, size: body.length, body });
    res.writeHead(ok ? 200 : 403).end(ok ? '' : '<Error><Code>SignatureDoesNotMatch</Code></Error>');
  });
  await new Promise((r) => s3.listen(0, r));
  s3Url = `http://127.0.0.1:${s3.address().port}`;

  dav = createServer(async (req, res) => {
    const body = await readBody(req);
    const ok = req.headers.authorization === 'Basic ' + Buffer.from('shop:dav-pass').toString('base64');
    davRequests.push({ url: req.url, ok, size: body.length });
    res.writeHead(ok ? 201 : 401).end();
  });
  await new Promise((r) => dav.listen(0, r));
  davUrl = `http://localhost:${dav.address().port}/remote.php/dav/files/shop/backups`;

  store = openDb(join(dir, 'shop.db'));
  server = createServer(createHandler(store, { backupDir, backupKeep: 3 }));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  owner = (await call('/auth/setup', 'POST', { name: 'Ramesh', username: 'ramesh', pin: '246810' }, null)).body.token;
  await call('/users', 'POST', { name: 'Ravi', username: 'ravi', role: 'cashier', pin: '4321' });
  cashier = (await call('/auth/login', 'POST', { username: 'ravi', pin: '4321' }, null)).body.token;
  await call('/stock-in', 'POST', { barcode: 'TEA', quantity: 10, name: 'Secret Masala Chai', price: 10000, cost: 8000 });
});
after(async () => {
  server.close(); s3.close(); dav.close();
  await rm(dir, { recursive: true, force: true });
});

test('signature matches the AWS documentation example', () => {
  const h = signV4({
    method: 'PUT', host: 'examplebucket.s3.amazonaws.com', path: '/' + encodeKey('test$file.text'),
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    payloadHash: createHash('sha256').update('Welcome to Amazon S3.').digest('hex'),
    accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1',
    date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(h.authorization, /Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
});

test('encryption round-trips, hides the data, and detects tampering or a wrong passphrase', async () => {
  const src = join(dir, 'plain.db');
  store.backupTo(src);
  const enc = join(dir, 'x.db.enc');
  await encryptFile(src, enc, PASS);
  const bytes = await readFile(enc);
  assert.equal(bytes.subarray(0, 8).toString(), 'HISAABBK');
  assert.ok(!bytes.includes('Secret Masala Chai') && !bytes.includes('SQLite format'), 'nothing readable inside');

  const out = join(dir, 'out.db');
  await decryptFile(enc, out, PASS);
  assert.deepEqual(await readFile(out), await readFile(src));

  await assert.rejects(decryptFile(enc, join(dir, 'bad1.db'), 'wrong passphrase!!'), /Wrong passphrase, or the file is damaged/);
  for (const at of [bytes.length - 40, 40]) { // data, then header
    const copy = Buffer.from(bytes);
    copy[at] ^= 1;
    await writeFile(join(dir, 't.enc'), copy);
    await assert.rejects(decryptFile(join(dir, 't.enc'), join(dir, `bad-${at}.db`), PASS));
  }
  await assert.rejects(stat(join(dir, 'bad1.db')), 'no half-written output is left behind');
});

test('backup settings: validation, secrets never sent back, owner only', async () => {
  assert.equal((await call('/backup/config', 'PUT', { passphrase: 'short' })).status, 400);
  assert.equal((await call('/backup/config', 'PUT', { destination: { type: 's3', endpoint: 'http://example.com', bucket: 'b', access_key: 'a', secret_key: 's' } })).status, 400, 'https only');
  assert.equal((await call('/backup/config', 'PUT', { destination: { type: 's3', endpoint: s3Url } })).status, 400, 'missing fields');
  const r = await call('/backup/config', 'PUT', {
    passphrase: PASS,
    destination: { type: 's3', endpoint: s3Url, region: 'auto', bucket: 'shop-backups', prefix: 'sharma', access_key: 'AKTEST', secret_key: 'test-secret-key' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.passphrase_set, true);
  assert.equal(r.body.destination.secret_key_set, true);
  assert.ok(!JSON.stringify(r.body).includes('test-secret-key') && !JSON.stringify(r.body).includes(PASS));
  // Saving again without the secret keeps it.
  await call('/backup/config', 'PUT', { destination: { type: 's3', endpoint: s3Url, region: 'auto', bucket: 'shop-backups', prefix: 'sharma', access_key: 'AKTEST' } });
  assert.equal(store.getBackupConfig().destination.secret_key, 'test-secret-key');
  const log = (await call('/audit-log?entity=backup')).body;
  assert.ok(!JSON.stringify(log).includes('test-secret-key') && !JSON.stringify(log).includes(PASS), 'audit log has no secrets');

  for (const [path, method] of [['/backup/config', 'GET'], ['/backup/config', 'PUT'], ['/backup/run', 'POST'], ['/backup/verify', 'POST'], ['/backup', 'GET']]) {
    assert.equal((await call(path, method, method === 'PUT' ? {} : undefined, cashier)).status, 403, `${method} ${path}`);
  }
});

test('back up now: encrypted, sent to S3 with a valid signature', async () => {
  const r = await call('/backup/run', 'POST');
  assert.equal(r.status, 200);
  const { local, offsite } = r.body.status;
  assert.equal(local.encrypted, true);
  assert.match(local.file, /^hisaab-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.db\.enc$/);
  assert.equal(offsite.ok, true, offsite.error);
  assert.equal(offsite.where, `shop-backups/sharma/${local.file}`);
  const sent = s3Requests.at(-1);
  assert.equal(sent.ok, true, 'signature checked by the fake S3');
  assert.equal(sent.url, `/shop-backups/sharma/${local.file}`);
  assert.deepEqual(sent.body, await readFile(join(backupDir, local.file)), 'the encrypted file, byte for byte');
});

test('a backup never contains the backup secrets or sign-in sessions', async () => {
  const file = join(backupDir, (await call('/backup/config')).body.status.local.file);
  const out = join(dir, 'check.db');
  await decryptFile(file, out, PASS);
  const db = new DatabaseSync(out, { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'backup%'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2, 'logins survive a restore');
  assert.equal(db.prepare("SELECT name FROM products WHERE barcode = 'TEA'").get().name, 'Secret Masala Chai');
  db.close();
  assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n > 0, 'the live database is untouched');
});

test('test restore proves the newest backup opens; a damaged one is reported', async () => {
  const ok = await call('/backup/verify', 'POST');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.products, 1);

  const file = join(backupDir, (await call('/backup/config')).body.status.local.file);
  const bytes = await readFile(file);
  bytes[bytes.length - 100] ^= 1;
  await writeFile(file, bytes);
  const bad = await call('/backup/verify', 'POST');
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /Wrong passphrase, or the file is damaged/);
});

test('a failed upload is recorded, and the local backup is still made', async () => {
  await call('/backup/config', 'PUT', { destination: { type: 's3', endpoint: s3Url, region: 'auto', bucket: 'shop-backups', access_key: 'AKTEST', secret_key: 'wrong-secret' } });
  const r = (await call('/backup/run', 'POST')).body.status;
  assert.equal(r.offsite.ok, false);
  assert.match(r.offsite.error, /403.*SignatureDoesNotMatch/);
  assert.ok(r.offsite.last_ok_at, 'remembers when it last worked');
  assert.ok(r.local.file);
});

test('WebDAV (Nextcloud) and a synced folder', async () => {
  await call('/backup/config', 'PUT', { destination: { type: 'webdav', url: davUrl, username: 'shop', password: 'dav-pass' } });
  let r = (await call('/backup/run', 'POST')).body.status;
  assert.equal(r.offsite.ok, true, r.offsite.error);
  assert.equal(davRequests.at(-1).url, `/remote.php/dav/files/shop/backups/${r.local.file}`);
  assert.ok(davRequests.at(-1).ok);

  const folder = join(dir, 'Google Drive', 'Hisaab');
  await call('/backup/config', 'PUT', { destination: { type: 'folder', path: folder } });
  r = (await call('/backup/run', 'POST')).body.status;
  assert.equal(r.offsite.ok, true, r.offsite.error);
  assert.deepEqual(await readFile(join(folder, r.local.file)), await readFile(join(backupDir, r.local.file)));
});

test('only the newest backups are kept locally', async () => {
  await call('/backup/run', 'POST');
  const files = (await readdir(backupDir)).filter((f) => f.startsWith('hisaab-'));
  assert.equal(files.length, 3);
  assert.ok(!(await readdir(backupDir)).some((f) => f.startsWith('.tmp')), 'no temporary files left');
});

test('download is encrypted once a passphrase is set', async () => {
  const r = await call('/backup');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /\.db\.enc"/);
  assert.equal(r.body.subarray(0, 8).toString(), 'HISAABBK');
});

test('restore script turns a backup back into a working database', async () => {
  const file = join(backupDir, (await call('/backup/config')).body.status.local.file);
  const out = join(dir, 'restored.db');
  const run = promisify(execFile);
  const env = { ...process.env, HISAAB_BACKUP_PASSPHRASE: PASS };
  const { stdout } = await run(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/restore.js', file, out], { env });
  assert.match(stdout, /Integrity check: ok/);
  const restored = openDb(out);
  assert.equal(restored.getByBarcode('TEA').name, 'Secret Masala Chai');
  await assert.rejects(run(process.execPath, ['scripts/restore.js', file, out], { env }), /already exists/);
  await assert.rejects(run(process.execPath, ['scripts/restore.js', file, join(dir, 'x.db')], { env: { ...env, HISAAB_BACKUP_PASSPHRASE: 'not the passphrase' } }),
    /Wrong passphrase/);
});

test('without a passphrase nothing is sent off-site', async () => {
  store.setBackupConfig({ passphrase: null, destination: { type: 'folder', path: join(dir, 'never') } }, {});
  const r = (await call('/backup/run', 'POST')).body.status;
  assert.equal(r.local.encrypted, false);
  assert.equal(r.offsite.ok, false);
  assert.match(r.offsite.error, /never sent off-site unencrypted/);
  await assert.rejects(stat(join(dir, 'never')));
});
