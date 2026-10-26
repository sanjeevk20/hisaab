// Turn a backup back into a database file you can run Hisaab on.
//
//   node scripts/restore.js <backup file> <new database file>
//
// For an encrypted backup (.db.enc) the passphrase is read from HISAAB_BACKUP_PASSPHRASE or asked
// for. The result is checked before you use it. To restore: stop Hisaab, keep the old
// data/hisaab.db somewhere safe, put the restored file in its place, start Hisaab.
// Logins survive a restore; everyone signs in again. Off-site backup settings must be re-entered.
import { copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { decryptFile, verifyBackup } from '../server/backup.js';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('Usage: node scripts/restore.js <backup file> <new database file>');
  process.exit(2);
}
if (existsSync(dest)) {
  console.error(`${dest} already exists — choose a new file name, so nothing is overwritten.`);
  process.exit(2);
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

try {
  const encrypted = src.endsWith('.enc');
  const passphrase = encrypted ? process.env.HISAAB_BACKUP_PASSPHRASE || await ask('Backup passphrase: ') : null;
  const check = await verifyBackup(src, passphrase);
  if (!check.ok) throw new Error(`The database inside failed its integrity check: ${check.integrity}`);
  if (encrypted) await decryptFile(src, dest, passphrase);
  else await copyFile(src, dest);
  console.log(`Restored ${dest}${check.created ? ` (backup made ${check.created})` : ''}: ${check.sales} bills, ${check.products} products, ${check.customers} customers. Integrity check: ok.`);
} catch (err) {
  console.error(`Could not restore: ${err.message}`);
  process.exit(1);
}
