// Builds the GitHub Pages demo into dist/: the app from public/, plus demo.js (the server code
// bundled for the browser) and SQLite as WebAssembly.   npm run build:demo
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = root + 'dist/';
const shim = (name) => root + `demo/shims/${name}.js`;
const NODE = {
  'node:sqlite': shim('sqlite'), 'node:crypto': shim('crypto'),
  'node:async_hooks': shim('node'), 'node:fs': shim('node'), 'node:fs/promises': shim('node'),
  'node:path': shim('node'), 'node:url': shim('node'), 'node:os': shim('node'),
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist);
await cp(root + 'public', dist, { recursive: true });

await build({
  entryPoints: [root + 'demo/main.js'],
  outfile: dist + 'demo.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  inject: [shim('buffer-global')],
  define: { 'process.env': '{}' },
  logLevel: 'warning',
  plugins: [{
    name: 'hisaab-demo',
    setup(b) {
      b.onResolve({ filter: /^node:/ }, (a) => {
        if (!NODE[a.path]) throw new Error(`${a.path} has no demo stand-in (imported by ${a.importer})`);
        return { path: NODE[a.path] };
      });
      // sql.js's browser build mentions Node modules it never loads in a browser.
      b.onResolve({ filter: /^(fs|path|crypto)$/ }, () => ({ path: shim('node') }));
      b.onResolve({ filter: /\/backup\.js$/ }, (a) => (a.importer.includes('/server/') ? { path: shim('backup') } : undefined));
    },
  }],
});
await cp(root + 'node_modules/sql.js/dist/sql-wasm-browser.wasm', dist + 'sql-wasm.wasm');

// Load the demo before the app, and cache it for offline use.
const html = await readFile(dist + 'index.html', 'utf8');
if (!html.includes('<script type="module" src="app.js"></script>')) throw new Error('index.html changed: app.js script tag not found');
await writeFile(dist + 'index.html', html
  .replace('<title>Hisaab</title>', '<title>Hisaab — demo</title>')
  .replace('<script type="module" src="app.js"></script>', '<script type="module" src="demo.js"></script>\n  <script type="module" src="app.js"></script>'));
const sw = await readFile(dist + 'sw.js', 'utf8');
await writeFile(dist + 'sw.js', sw
  .replace(/const CACHE = '([^']+)';/, `const CACHE = '$1-demo-${Date.now().toString(36)}';`)
  .replace("'icon.svg'];", "'icon.svg', 'demo.js', 'sql-wasm.wasm'];"));
await writeFile(dist + '.nojekyll', '');
console.log('Demo built in dist/');
