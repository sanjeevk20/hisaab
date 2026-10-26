// The demo keeps its data in this browser; encrypted and off-site backups need the real server.
const notInDemo = () => { throw new Error('Backups need Hisaab running on your own server'); };
export const DESTINATIONS = { s3: { secrets: ['secret_key'] }, webdav: { secrets: ['password'] }, folder: { secrets: [] } };
export const MIN_PASSPHRASE = 12;
export const backupPassphrase = () => null;
export const encryptFile = notInDemo;
export const latestBackup = notInDemo;
export const runBackup = notInDemo;
export const verifyBackup = notInDemo;
