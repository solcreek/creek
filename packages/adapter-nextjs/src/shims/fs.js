// Minimal fs shim for CF Workers — Next.js server needs basic fs operations
// for manifest loading and incremental cache. We provide no-ops since
// manifests are embedded and cache uses DO (Phase 2).
const noop = () => {};
const noopSync = () => undefined;

export const existsSync = () => false;
export const readFileSync = (path, enc) => {
  // Try reading from embedded manifests
  if (typeof globalThis.__MANIFESTS !== "undefined") {
    for (const [key, val] of Object.entries(globalThis.__MANIFESTS)) {
      if (key === path || key.endsWith(path) || path.endsWith(key.split("/").pop())) {
        return val;
      }
    }
  }
  return "";
};
export const writeFileSync = noop;
export const mkdirSync = noop;
export const unlinkSync = noop;
export const readdirSync = () => [];
export const statSync = () => ({
  isFile: () => false,
  isDirectory: () => false,
  mtime: new Date(0),
  size: 0,
});
export const accessSync = noop;
export const createReadStream = () => { throw new Error("fs.createReadStream not available in CF Workers"); };
export const createWriteStream = () => { throw new Error("fs.createWriteStream not available in CF Workers"); };

export const promises = {
  readFile: async (path, enc) => readFileSync(path, enc),
  writeFile: async () => {},
  mkdir: async () => {},
  readdir: async () => [],
  stat: async () => statSync(),
  access: async () => {},
  unlink: async () => {},
  rm: async () => {},
};

export default {
  existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync,
  readdirSync, statSync, accessSync, createReadStream, createWriteStream,
  promises,
};
