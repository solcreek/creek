/**
 * `_headers` / `_redirects` — asset *configuration*, not assets.
 *
 * Cloudflare's Static Assets treats these two root-level files as config:
 * their raw contents are sent in the script upload metadata under
 * `assets.config`, and the files themselves are excluded from the uploaded
 * manifest. Wrangler does both (see `workers-shared/utils/constants.ts`:
 * `REDIRECTS_FILENAME` / `HEADERS_FILENAME`, and `createWorkerUploadForm`,
 * which sets `_redirects` / `_headers` alongside `html_handling`,
 * `not_found_handling` and `run_worker_first`).
 *
 * Creek's deploy path did neither. It uploaded `_headers` as an ordinary
 * asset and sent `config: {}`, so:
 *
 *   - the rules never applied — `/_next/static/*` kept Cloudflare's
 *     default `public, max-age=0, must-revalidate`, forcing a browser
 *     revalidation for every chunk on every navigation
 *   - the file itself was publicly fetchable at `/_headers`
 *
 * Worse, `wrangler dev` DOES parse the file, so the same project behaved
 * correctly locally and silently did nothing in production. A tenant
 * reported exactly this on 2026-07-24, having closed and reopened their
 * own issue over the false positive.
 *
 * Root level only, matching wrangler: its default ignore patterns are
 * `/_headers` and `/_redirects` with a leading slash, so a nested
 * `docs/_headers` stays an ordinary asset.
 */

/** Root-level filenames consumed as config rather than served. */
export const ASSET_METAFILES = ["_headers", "_redirects"] as const;

export interface AssetMetafiles {
  /**
   * Fields to merge into the `assets.config` object of the script upload
   * metadata. Empty when the project ships neither file.
   */
  config: { _headers?: string; _redirects?: string };
  /**
   * True when an asset path is a metafile and must be kept out of the
   * upload manifest.
   */
  isMetafile(filePath: string): boolean;
}

/** Normalize to a leading-slash key, the shape the manifest uses. */
function normalize(filePath: string): string {
  return filePath.startsWith("/") ? filePath : `/${filePath}`;
}

/**
 * Pull `_headers` / `_redirects` out of a built asset set.
 *
 * Callers must both spread `config` into the assets config they upload AND
 * skip `isMetafile` paths when building the manifest — doing only the first
 * would leave the file publicly readable.
 */
export function extractAssetMetafiles(clientAssets: Record<string, ArrayBuffer>): AssetMetafiles {
  const rootKeys = new Set(ASSET_METAFILES.map((name) => `/${name}`));
  const config: { _headers?: string; _redirects?: string } = {};
  const found = new Set<string>();

  const decoder = new TextDecoder();
  for (const [filePath, content] of Object.entries(clientAssets)) {
    const key = normalize(filePath);
    if (!rootKeys.has(key)) continue;
    found.add(key);
    // `key` is one of ASSET_METAFILES, so this narrows to a valid field.
    config[key.slice(1) as "_headers" | "_redirects"] = decoder.decode(content);
  }

  return {
    config,
    isMetafile(filePath: string): boolean {
      return found.has(normalize(filePath));
    },
  };
}
