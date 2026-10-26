// Encrypted backups and copying them off the machine.
//
// File format (.db.enc): "HISAABBK" | uint32 header length | JSON header | ciphertext | 16-byte tag.
// The database is gzipped, then encrypted with AES-256-GCM under a key derived from the owner's
// passphrase with scrypt (fresh salt and IV per file). The header is authenticated too, so any
// change to the file — header or data — makes decryption fail instead of yielding bad data.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const MAGIC = Buffer.from('HISAABBK');
const KDF = { N: 2 ** 15, r: 8, p: 1 };
export const MIN_PASSPHRASE = 12;
export const BACKUP_NAME = /^hisaab-[\dT-]+\.db(\.enc)?$/;

const deriveKey = (passphrase, salt, { N, r, p }) => new Promise((resolve, reject) =>
  scrypt(String(passphrase).normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key))));

export async function encryptFile(src, dest, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.from(JSON.stringify({
    v: 1, alg: 'aes-256-gcm', kdf: 'scrypt', ...KDF, salt: salt.toString('base64'), iv: iv.toString('base64'),
    compression: 'gzip', created: new Date().toISOString(),
  }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  const prefix = Buffer.concat([MAGIC, len, header]);
  const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt, KDF), iv);
  cipher.setAAD(prefix);
  await writeFile(dest, prefix);
  await pipeline(createReadStream(src), createGzip({ level: 9 }), cipher, createWriteStream(dest, { flags: 'a' }));
  await appendFile(dest, cipher.getAuthTag());
}

export async function readHeader(file) {
  const fh = await open(file, 'r');
  try {
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    if (!head.subarray(0, 8).equals(MAGIC)) throw new Error('Not a Hisaab encrypted backup');
    const len = head.readUInt32BE(8);
    if (len > 4096) throw new Error('Damaged backup header');
    const json = Buffer.alloc(len);
    await fh.read(json, 0, len, 12);
    return { header: JSON.parse(json.toString()), prefix: Buffer.concat([head, json]) };
  } finally {
    await fh.close();
  }
}

// Throws 'Wrong passphrase, or the file is damaged' if the passphrase is wrong or anything changed.
export async function decryptFile(src, dest, passphrase) {
  const { header, prefix } = await readHeader(src);
  if (header.v !== 1 || header.alg !== 'aes-256-gcm' || header.kdf !== 'scrypt') throw new Error('Unsupported backup format');
  const { size } = await stat(src);
  const tag = Buffer.alloc(16);
  const fh = await open(src, 'r');
  await fh.read(tag, 0, 16, size - 16);
  await fh.close();
  const key = await deriveKey(passphrase, Buffer.from(header.salt, 'base64'), header);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAAD(prefix);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(src, { start: prefix.length, end: size - 17 }), decipher, createGunzip(), createWriteStream(dest));
  } catch {
    await rm(dest, { force: true });
    throw new Error('Wrong passphrase, or the file is damaged');
  }
  return header;
}

// Opens a backup (decrypting it if needed) and checks the database inside is complete.
export async function verifyBackup(file, passphrase) {
  const tmp = join(file + `.verify-${process.pid}-${Date.now()}`);
  try {
    let created = null;
    if (file.endsWith('.enc')) created = (await decryptFile(file, tmp, passphrase)).created;
    else await copyFile(file, tmp);
    const db = new DatabaseSync(tmp, { readOnly: true });
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
      const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      return { ok: integrity === 'ok', integrity, file: basename(file), created, sales: count('sales'), products: count('products'), customers: count('customers') };
    } finally {
      db.close();
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

// --- S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces) -----

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
// RFC 3986 encoding, as Signature V4 requires (encodeURIComponent leaves !'()* alone).
const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export const encodeKey = (key) => key.split('/').map(uriEncode).join('/');

// AWS Signature Version 4 for a request without a query string. `headers` are the headers to
// sign besides host, x-amz-date and x-amz-content-sha256. Returns the headers to send.
export function signV4({ method, host, path, headers = {}, payloadHash, accessKey, secretKey, region, service = 's3', date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const canonical = [method, path, '', ...names.map((n) => `${n}:${all[n]}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope},SignedHeaders=${names.join(';')},Signature=${signature}`,
  };
}

async function putS3(dest, name, body) {
  const endpoint = new URL(dest.endpoint);
  const key = [dest.prefix?.replace(/^\/+|\/+$/g, ''), name].filter(Boolean).join('/');
  // Path style (endpoint/bucket/key) works with R2, B2, Wasabi and MinIO; AWS prefers the bucket
  // in the host name.
  const pathStyle = dest.path_style ?? !endpoint.hostname.endsWith('amazonaws.com');
  const host = pathStyle ? endpoint.host : `${dest.bucket}.${endpoint.host}`;
  const path = pathStyle ? `/${uriEncode(dest.bucket)}/${encodeKey(key)}` : `/${encodeKey(key)}`;
  const headers = signV4({
    method: 'PUT', host, path, payloadHash: sha256(body), accessKey: dest.access_key, secretKey: dest.secret_key,
    region: dest.region || 'auto', headers: { 'content-type': 'application/octet-stream' },
  });
  delete headers.host; // fetch sets it from the URL
  const res = await fetch(`${endpoint.protocol}//${host}${path}`, { method: 'PUT', headers, body, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Storage said ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return `${dest.bucket}/${key}`;
}

// --- WebDAV (Nextcloud, ownCloud, many NAS boxes) ------------------------------------------------

async function putWebdav(dest, name, body) {
  const url = `${dest.url.replace(/\/+$/, '')}/${uriEncode(name)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { authorization: 'Basic ' + Buffer.from(`${dest.username}:${dest.password}`).toString('base64'), 'content-type': 'application/octet-stream' },
    body, signal: AbortSignal.timeout(120_000),
  });
  if (![200, 201, 204].includes(res.status)) throw new Error(`Server said ${res.status}`);
  return url.replace(/\/\/[^/@]*@/, '//');
}

// --- A folder: one synced by Google Drive / Dropbox / OneDrive, or a USB drive -------------------

async function putFolder(dest, name, file) {
  await mkdir(dest.path, { recursive: true });
  const target = join(dest.path, name);
  await copyFile(file, target + '.part');
  await rename(target + '.part', target);
  const [a, b] = await Promise.all([stat(file), stat(target)]);
  if (a.size !== b.size) throw new Error('The copy in the folder is incomplete');
  return target;
}

export const DESTINATIONS = {
  s3: { label: 'S3-compatible storage', required: ['endpoint', 'bucket', 'access_key', 'secret_key'], secrets: ['secret_key'] },
  webdav: { label: 'WebDAV', required: ['url', 'username', 'password'], secrets: ['password'] },
  folder: { label: 'Folder', required: ['path'], secrets: [] },
};

export async function upload(dest, file) {
  const name = basename(file);
  if (dest.type === 'folder') return putFolder(dest, name, file);
  const body = await readFile(file);
  if (dest.type === 's3') return putS3(dest, name, body);
  if (dest.type === 'webdav') return putWebdav(dest, name, body);
  throw new Error(`Unknown destination ${dest.type}`);
}

// --- one backup run ---------------------------------------------------------------------------

export const backupPassphrase = (config) => process.env.HISAAB_BACKUP_PASSPHRASE || config.passphrase || null;

// Makes a backup in `dir` (encrypted when a passphrase is set), copies it off-site when a
// destination is set, prunes old local copies, and records how it went.
export async function runBackup(store, { dir, keep = 60 }) {
  const config = store.getBackupConfig();
  const passphrase = backupPassphrase(config);
  const at = new Date().toISOString();
  const stamp = at.slice(0, 23).replace(/[:.]/g, '-'); // to the millisecond, so two runs never collide
  await mkdir(dir, { recursive: true });
  const plain = join(dir, `.tmp-${stamp}-${process.pid}.db`);
  const status = { ...store.getBackupStatus() };
  try {
    store.backupTo(plain);
    const file = join(dir, `hisaab-${stamp}.db${passphrase ? '.enc' : ''}`);
    if (passphrase) {
      await encryptFile(plain, file, passphrase);
      await rm(plain);
    } else {
      await rename(plain, file);
    }
    status.local = { at, file: basename(file), size: (await stat(file)).size, encrypted: Boolean(passphrase) };

    if (config.destination?.type) {
      try {
        if (!passphrase) throw new Error('Set a backup passphrase first — backups are never sent off-site unencrypted');
        const where = await upload(config.destination, file);
        status.offsite = { at, ok: true, file: basename(file), where, last_ok_at: at };
      } catch (err) {
        status.offsite = { ...status.offsite, at, ok: false, error: err.message };
      }
    }

    const old = (await readdir(dir)).filter((f) => BACKUP_NAME.test(f)).sort().slice(0, -keep);
    for (const f of old) await rm(join(dir, f), { force: true });
    return status;
  } finally {
    await rm(plain, { force: true });
    store.saveBackupStatus(status);
  }
}

export async function latestBackup(dir) {
  const files = (await readdir(dir).catch(() => [])).filter((f) => BACKUP_NAME.test(f)).sort();
  return files.length ? join(dir, files.at(-1)) : null;
}
