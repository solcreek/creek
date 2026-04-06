// Shim for next/dist/server/node-environment-extensions/fast-set-immediate
// CF Workers with nodejs_compat already provides setImmediate.
// The original module tries to assign to node:timers/promises which is
// frozen in CF Workers ESM. This shim is a no-op since the polyfill
// isn't needed.
export function install() {}
