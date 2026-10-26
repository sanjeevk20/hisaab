// Entry point. Set HTTPS_KEY/HTTPS_CERT to serve over TLS — phone browsers only allow
// camera access on https:// (or on localhost).
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createHandler } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const store = openDb(process.env.HISAAB_DB ?? 'data/hisaab.db');
const handler = createHandler(store, { pin: process.env.HISAAB_PIN || undefined });

// Rule 57: keep restorable backups. One copy per day in HISAAB_BACKUP_DIR (default data/backups),
// keeping the newest HISAAB_BACKUP_KEEP (default 60). Copy that folder off the machine regularly.
const backupDir = process.env.HISAAB_BACKUP_DIR ?? 'data/backups';
const keep = Number(process.env.HISAAB_BACKUP_KEEP ?? 60);
const BACKUP_FILE = /^hisaab-\d{4}-\d{2}-\d{2}\.db$/;
function dailyBackup() {
  try {
    mkdirSync(backupDir, { recursive: true });
    const file = join(backupDir, `hisaab-${new Date().toISOString().slice(0, 10)}.db`);
    if (!existsSync(file)) {
      store.backupTo(file);
      console.log(`Backup written: ${file}`);
    }
    for (const old of readdirSync(backupDir).filter((f) => BACKUP_FILE.test(f)).sort().slice(0, -keep)) {
      rmSync(join(backupDir, old));
    }
  } catch (err) {
    console.error('Backup failed:', err.message);
  }
}
if (process.env.HISAAB_DB !== ':memory:') {
  dailyBackup();
  setInterval(dailyBackup, 60 * 60 * 1000).unref(); // checks hourly, writes once a day
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
