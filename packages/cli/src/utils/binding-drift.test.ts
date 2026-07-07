import { describe, it, expect } from "vitest";
import { findUndeclaredBindings, formatBindingDrift, type BindingClient } from "./binding-drift.js";

function fakeClient(opts: {
  bindings?: Array<{ bindingName: string; kind: string }>;
  error?: Error;
}): BindingClient {
  return {
    async listBindings() {
      if (opts.error) throw opts.error;
      return { bindings: opts.bindings ?? [] };
    },
  };
}

describe("findUndeclaredBindings", () => {
  it("flags a server binding whose name isn't declared locally", async () => {
    // `creek cache attach --as=SESSIONS` lives server-side as "SESSIONS",
    // but creek.toml `cache = true` declares "KV" — so SESSIONS is undeclared.
    // `kind` is the semantic resource kind from the API ("cache"), not "kv".
    const client = fakeClient({
      bindings: [
        { bindingName: "KV", kind: "cache" },
        { bindingName: "SESSIONS", kind: "cache" },
      ],
    });
    const drift = await findUndeclaredBindings(client, "app", ["KV"]);
    expect(drift).toEqual([{ bindingName: "SESSIONS", kind: "cache" }]);
  });

  it("returns nothing when every attachment is declared", async () => {
    const client = fakeClient({
      bindings: [
        { bindingName: "DB", kind: "database" },
        { bindingName: "STORAGE", kind: "storage" },
      ],
    });
    const drift = await findUndeclaredBindings(client, "app", ["DB", "STORAGE"]);
    expect(drift).toEqual([]);
  });

  it("is best-effort — returns [] when the lookup throws", async () => {
    const client = fakeClient({ error: new Error("network") });
    const drift = await findUndeclaredBindings(client, "app", []);
    expect(drift).toEqual([]);
  });

  it("formats drift as a readable one-liner", () => {
    expect(
      formatBindingDrift([
        { bindingName: "SESSIONS", kind: "cache" },
        { bindingName: "DATA", kind: "database" },
      ]),
    ).toBe("SESSIONS (cache), DATA (database)");
  });
});
