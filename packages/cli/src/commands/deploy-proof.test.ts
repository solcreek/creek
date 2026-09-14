import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyUrl, type VerifyResult } from "../utils/verify-url.js";
import { finishProductionSuccess, productionProofPayload } from "./deploy.js";

vi.mock("../utils/verify-url.js", () => ({
  verifyUrl: vi.fn(),
}));

const mockedVerifyUrl = vi.mocked(verifyUrl);

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}

function liveProof(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    ok: true,
    url: "https://app.example.com",
    status: 200,
    title: "App",
    ttfbMs: 12,
    contentType: "text/html",
    sandboxId: null,
    contains: [],
    ...overrides,
  };
}

describe("productionProofPayload", () => {
  it("attaches proof and ok when the URL is live", () => {
    const proof = liveProof();
    expect(productionProofPayload(proof.url, proof)).toEqual({
      ok: true,
      url: proof.url,
      proof,
    });
  });

  it("keeps the URL and sets verify_failed when proof is not ok", () => {
    const proof = liveProof({ ok: false, status: 500, error: "HTTP 500" });
    expect(productionProofPayload(proof.url, proof)).toEqual({
      ok: false,
      error: "verify_failed",
      url: proof.url,
      proof,
    });
  });

  it("fails with no_url when the URL is missing", () => {
    expect(productionProofPayload(null, null)).toEqual({
      ok: false,
      error: "no_url",
      message: "Production deploy succeeded but no URL was returned",
    });
    expect(productionProofPayload(undefined, null).error).toBe("no_url");
    expect(productionProofPayload("", null).error).toBe("no_url");
  });
});

describe("finishProductionSuccess", () => {
  let stdout: string;
  beforeEach(() => {
    stdout = "";
    mockedVerifyUrl.mockReset();
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function runExit(promise: Promise<unknown>): Promise<number> {
    try {
      await promise;
      throw new Error("expected the command to call process.exit");
    } catch (err) {
      if (err instanceof ExitSignal) return err.code;
      throw err;
    }
  }
  function json() {
    return JSON.parse(stdout);
  }

  const payload = { deploymentId: "dep_1", version: 3, mode: "production" };

  it("JSON ok true, proof attached, exit 0 when URL is live", async () => {
    const proof = liveProof();
    mockedVerifyUrl.mockResolvedValue(proof);
    const human = vi.fn();
    const code = await runExit(
      finishProductionSuccess({
        jsonMode: true,
        url: proof.url,
        slug: "myproj",
        payload,
        human,
      }),
    );
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      url: proof.url,
      proof,
      deploymentId: "dep_1",
      version: 3,
    });
    expect(json().error).toBeUndefined();
    expect(mockedVerifyUrl).toHaveBeenCalledWith(proof.url, { timeoutMs: 10_000 });
    expect(human).not.toHaveBeenCalled();
  });

  it("JSON ok false, error verify_failed, url kept, exit 1 when proof fails", async () => {
    const proof = liveProof({ ok: false, status: 500, error: "HTTP 500" });
    mockedVerifyUrl.mockResolvedValue(proof);
    const code = await runExit(
      finishProductionSuccess({
        jsonMode: true,
        url: proof.url,
        slug: "myproj",
        payload,
        human: vi.fn(),
      }),
    );
    expect(code).toBe(1);
    expect(json()).toMatchObject({
      ok: false,
      error: "verify_failed",
      url: proof.url,
      proof,
      deploymentId: "dep_1",
    });
  });

  it("JSON ok false, error no_url, exit 1 when URL is missing", async () => {
    const human = vi.fn();
    const code = await runExit(
      finishProductionSuccess({
        jsonMode: true,
        url: null,
        slug: "myproj",
        payload,
        human,
      }),
    );
    expect(code).toBe(1);
    expect(json()).toMatchObject({
      ok: false,
      error: "no_url",
      message: "Production deploy succeeded but no URL was returned",
      deploymentId: "dep_1",
      version: 3,
    });
    expect(json().proof).toBeUndefined();
    expect(json().url).toBeUndefined();
    expect(mockedVerifyUrl).not.toHaveBeenCalled();
    expect(human).not.toHaveBeenCalled();
  });

  it("human missing URL still prints deployment details then exits 1", async () => {
    const human = vi.fn();
    const code = await runExit(
      finishProductionSuccess({
        jsonMode: false,
        url: null,
        slug: "myproj",
        payload,
        human,
      }),
    );
    expect(code).toBe(1);
    expect(human).toHaveBeenCalledOnce();
    expect(mockedVerifyUrl).not.toHaveBeenCalled();
  });
});
