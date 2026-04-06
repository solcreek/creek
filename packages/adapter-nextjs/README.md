# @solcreek/adapter-nextjs

Creek 的 Next.js adapter，實作 Next.js 16.2+ 的 `NextAdapter` interface。直接將 Next.js build output 打包為 Cloudflare Workers，取代 opennext + wrangler 的多步驟流程。

## 現狀

| 功能 | 狀態 |
|------|:----:|
| Static pages / SSG | ✅ 可運作 |
| React hydration | ✅ 可運作 |
| CF Workers deploy | ✅ 通過 validation |
| SSR (Server-Side Rendering) | ✅ 可運作（103 Early Hints） |
| ISR / Cache | 🔲 Phase 2 |
| Middleware | 🔲 Phase 2 |

## Requirements

- Next.js >= 16.2（需要 `NextAdapter` interface 支援）
- `next build` 必須使用 `--webpack` flag（Turbopack 的 R.c chunk format 與 esbuild 不相容）

## 運作方式

```
next build --webpack
  → adapter.modifyConfig: output: "standalone", outputFileTracingRoot
  → adapter.onBuildComplete:
    1. Collect static files (typed outputs)
    2. Collect manifests from .next/ (JSON + JS files)
    3. Generate worker entry:
       - @next/routing resolveRoutes
       - Lazy import() handlers
       - Manifests singleton init (RSC + server actions)
       - IncomingMessage/ServerResponse bridge (http.js shim)
    4. esbuild bundle (platform: node, banner shims)
    5. Post-build: __require normalization
    6. Write manifest.json
  → CLI uploads to WfP
```

Build pipeline 用 esbuild plugins（define/banner/onLoad/alias）處理 14 個 CF Workers 相容性問題，不依賴 post-build string patching。SSR 透過 swallow handler Promise rejection + `res.finish` event 監聽實現。

## 與 opennext 方案的差異

| | opennext 方案 | Creek adapter |
|--|:---:|:---:|
| Worker size (gzipped) | 2.6 MB | ~1.5 MB |
| Build 步驟 | 8 步 | 1 步 |
| 依賴 | opennext + wrangler | esbuild only |

## 相關文件

- [creek-nextjs-adapter.md](../../../product-planning/creek-nextjs-adapter.md) — 設計文件與實作 findings
- [creek-adapter-cf-workers-compat.md](../../../product-planning/creek-adapter-cf-workers-compat.md) — CF Workers 相容性問題完整對照表
