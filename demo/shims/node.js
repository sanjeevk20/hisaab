// Stand-ins for the Node built-ins the server imports but the demo never needs at runtime
// (files, static serving, backups). Anything that would really use them throws.
const notInDemo = () => { throw new Error('Not available in the demo'); };

// async_hooks: the demo has no logins, so there is never a current user to carry.
export class AsyncLocalStorage {
  getStore() { return this.store; }
  run(store, fn) { this.store = store; return fn(); }
}

// fs, fs/promises
export const mkdirSync = () => {};
export const existsSync = () => false;
export const readFileSync = notInDemo;
export const createReadStream = notInDemo;
export const createWriteStream = notInDemo;
export const readFile = notInDemo;
export const writeFile = notInDemo;
export const appendFile = notInDemo;
export const copyFile = notInDemo;
export const mkdtemp = notInDemo;
export const mkdir = notInDemo;
export const readdir = notInDemo;
export const rename = notInDemo;
export const rm = notInDemo;
export const stat = notInDemo;
export const open = notInDemo;

// path, url, os
export const sep = '/';
export const join = (...p) => p.join('/').replace(/\/+/g, '/');
export const normalize = (p) => p;
export const dirname = (p) => p.replace(/\/[^/]*$/, '') || '/';
export const basename = (p) => p.replace(/^.*\//, '');
export const extname = (p) => (/\.[^./]*$/.exec(p) ?? [''])[0];
export const fileURLToPath = () => '/';
export const tmpdir = () => '/tmp';
