// Entry point. Set HTTPS_KEY/HTTPS_CERT to serve over TLS — phone browsers only allow
// camera access on https:// (or on localhost).
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { openDb } from './db.js';
import { createHandler } from './app.js';
import { runBackup } from './backup.js';

const port = Number(process.env.PORT ?? 3000);
const store = openDb(process.env.HISAAB_DB ?? 'data/hisaab.db');

// Rule 57: keep restorable backups. Once a day a backup goes to HISAAB_BACKUP_DIR (default
// data/backups), encrypted when a backup passphrase is set, and is copied off-site when a
// destination is set (Settings → Backups). The newest HISAAB_BACKUP_KEEP (default 60) are kept here.
const backupDir = process.env.HISAAB_BACKUP_DIR ?? 'data/backups';
const backupKeep = Number(process.env.HISAAB_BACKUP_KEEP ?? 60);
const handler = createHandler(store, { pin: process.env.HISAAB_PIN || undefined, backupDir, backupKeep });

async function dailyBackup() {
  const last = store.getBackupStatus().local?.at?.slice(0, 10);
  if (last === new Date().toISOString().slice(0, 10)) return;
  try {
    const status = await runBackup(store, { dir: backupDir, keep: backupKeep });
    console.log(`Backup written: ${status.local.file}${status.local.encrypted ? ' (encrypted)' : ''}`);
    if (status.offsite?.at === status.local.at) {
      console.log(status.offsite.ok ? `  copied off-site: ${status.offsite.where}` : `  OFF-SITE COPY FAILED: ${status.offsite.error}`);
    }
  } catch (err) {
    console.error('Backup failed:', err.message);
  }
}
if (process.env.HISAAB_DB !== ':memory:') {
  dailyBackup();
  setInterval(dailyBackup, 60 * 60 * 1000).unref(); // checks hourly, runs once a day
}

const tls = process.env.HTTPS_KEY && process.env.HTTPS_CERT;
const server = tls
  ? createHttps({ key: readFileSync(process.env.HTTPS_KEY), cert: readFileSync(process.env.HTTPS_CERT) }, handler)
  : createHttp(handler);

server.listen(port, () => {
  const scheme = tls ? 'https' : 'http';
  console.log(`Hisaab running at ${scheme}://localhost:${port}`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  on your network: ${scheme}://${a.address}:${port}`);
    }
  }
  if (!tls) console.log('  (phones need https for the camera — see README "Using it on a phone")');
});
