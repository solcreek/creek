// Shim for next/dist/server/load-manifest.external.js
// Reads manifests from globalThis.__MANIFESTS (embedded at build time by the adapter).

const cache = new Map();

function findInManifests(path) {
  const manifests = globalThis.__MANIFESTS;
  if (!manifests) return undefined;

  // Direct match
  if (manifests[path]) return manifests[path];

  // Match by .next/ relative tail — handles path prefix differences
  // Requested: //.next/routes-manifest.json
  // Available: /Users/.../apps/www/.next/routes-manifest.json
  const tail = path.includes(".next/")
    ? ".next/" + path.split(".next/").pop()
    : path.split("/").pop();

  for (const [key, val] of Object.entries(manifests)) {
    const keyTail = key.includes(".next/")
      ? ".next/" + key.split(".next/").pop()
      : key.split("/").pop();
    if (tail === keyTail) return val;
  }

  return undefined;
}

function loadManifest(path, shouldCache = true, _cache = cache, skipParse = false, handleMissing) {
  const cached = shouldCache && cache.get(path);
  if (cached) return cached;

  const content = findInManifests(path);

  if (content === undefined) {
    if (handleMissing) {
      const result = {};
      if (shouldCache) cache.set(path, result);
      return result;
    }
    throw new Error(`[Creek] Manifest not found: ${path}`);
  }

  let manifest = skipParse ? content : JSON.parse(content);
  if (shouldCache) cache.set(path, manifest);
  return manifest;
}

function evalManifest(path, shouldCache = true, _cache = cache, handleMissing) {
  const cached = shouldCache && cache.get(path);
  if (cached) return cached;

  const content = findInManifests(path);

  if (content === undefined) {
    if (handleMissing) {
      const result = {};
      if (shouldCache) cache.set(path, result);
      return result;
    }
    throw new Error(`[Creek] Manifest not found for eval: ${path}`);
  }

  let contextObject = {};
  try {
    contextObject = JSON.parse(content);
  } catch {
    // JS manifests (e.g., _buildManifest.js) — run in sandbox
    try {
      const fn = new Function("self", content);
      const selfObj = {};
      fn(selfObj);
      contextObject = selfObj;
    } catch {}
  }

  if (shouldCache) cache.set(path, contextObject);
  return contextObject;
}

function loadManifestFromRelativePath({ projectDir, distDir, manifest, shouldCache, cache: c, skipParse, handleMissing, useEval }) {
  const manifestPath = (projectDir || "") + "/" + (distDir || ".next") + "/" + manifest;
  if (useEval) return evalManifest(manifestPath, shouldCache, c, handleMissing);
  return loadManifest(manifestPath, shouldCache, c, skipParse, handleMissing);
}

function clearManifestCache(path) {
  return cache.delete(path);
}

module.exports = { loadManifest, evalManifest, loadManifestFromRelativePath, clearManifestCache };
