// Entry point. Set HTTPS_KEY/HTTPS_CERT to serve over TLS — phone browsers only allow
// camera access on https:// (or on localhost).
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { openDb } from './db.js';
import { createHandler } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const store = openDb(process.env.HISAAB_DB ?? 'data/hisaab.db');
const handler = createHandler(store, { pin: process.env.HISAAB_PIN || undefined });

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
