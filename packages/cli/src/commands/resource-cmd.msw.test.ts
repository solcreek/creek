import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { dbCommand } from "./db.js";
import { storageCommand } from "./storage.js";
import { cacheCommand } from "./cache.js";

// Re-running `creek db|storage|cache create/attach/detach/delete` against a
// stateful fake control plane that answers as the real one does: a 409
// `conflict` with `existing` for a taken resource or binding name, a 404 with
// `missing` for an absent binding, and deleted resources (names still
// reserved) only under `?include=deleted`. Tests run non-TTY, so every
// command prints JSON and exits through process.exit, which is stubbed.
const API = "https://cp.test";

interface FakeResource {
  id: string;
  teamId: string;
  kind: string;
  name: string;
  cfResourceId: string | null;
  cfResourceType: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}
interface FakeBinding {
  projectId: string;
  bindingName: string;
  resourceId: string;
  createdAt: number;
}

let resources: FakeResource[];
let bindings: FakeBinding[];
const PROJECTS: Record<string, string> = { app: "proj-app" };

function seed(kind: string, name: string, status = "active"): FakeResource {
  const r = {
    id: `res-${resources.length + 1}`,
    teamId: "team-1",
    kind,
    name,
    cfResourceId: `cf-${name}`,
    cfResourceType: null,
    status,
    createdAt: 1,
    updatedAt: 1,
  };
  resources.push(r);
  return r;
}

const fakeControlPlane = [
  http.get(`${API}/resources`, ({ request }) => {
    const withDeleted = new URL(request.url).searchParams.get("include") === "deleted";
    return HttpResponse.json({
      resources: resources.filter((r) => withDeleted || r.status !== "deleted"),
    });
  }),
  http.post(`${API}/resources`, async ({ request }) => {
    const { kind, name } = (await request.json()) as { kind: string; name: string };
    const existing = resources.find((r) => r.name === name);
    if (existing) {
      return HttpResponse.json(
        {
          error: "conflict",
          message: `A ${existing.kind} named '${name}' exists`,
          existing: { id: existing.id, kind: existing.kind, name, status: existing.status },
        },
        { status: 409 },
      );
    }
    return HttpResponse.json(seed(kind, name), { status: 201 });
  }),
  http.delete(`${API}/resources/:id`, ({ params }) => {
    const r = resources.find((x) => x.id === params.id && x.status !== "deleted");
    if (!r) return HttpResponse.json({ error: "not_found" }, { status: 404 });
    r.status = "deleted";
    return HttpResponse.json({ id: r.id, status: "deleted" });
  }),
  http.post(`${API}/projects/:slug/bindings`, async ({ params, request }) => {
    const projectId = PROJECTS[params.slug as string];
    if (!projectId) {
      return HttpResponse.json({ error: "not_found", message: "project" }, { status: 404 });
    }
    const { resourceId, bindingName } = (await request.json()) as FakeBinding;
    const held = bindings.find((b) => b.projectId === projectId && b.bindingName === bindingName);
    if (held) {
      const r = resources.find((x) => x.id === held.resourceId)!;
      return HttpResponse.json(
        {
          error: "conflict",
          message: `Binding '${bindingName}' already exists for this project`,
          existing: { resourceId: held.resourceId, kind: r.kind, name: r.name },
        },
        { status: 409 },
      );
    }
    const binding = { projectId, bindingName, resourceId, createdAt: 2 };
    bindings.push(binding);
    return HttpResponse.json(binding, { status: 201 });
  }),
  http.delete(`${API}/projects/:slug/bindings/:name`, ({ params }) => {
    const projectId = PROJECTS[params.slug as string];
    if (!projectId) {
      return HttpResponse.json(
        { error: "not_found", missing: "project", message: `No project '${params.slug}'` },
        { status: 404 },
      );
    }
    const i = bindings.findIndex((b) => b.projectId === projectId && b.bindingName === params.name);
    if (i < 0) {
      return HttpResponse.json(
        { error: "not_found", missing: "binding", message: "no such binding" },
        { status: 404 },
      );
    }
    bindings.splice(i, 1);
    return HttpResponse.json({ ok: true });
  }),
];

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}

let stdout: string;
// The real process.exit ends the run, but the stub's throw can land in the
// command's own catch, which then prints again. Keep what the first exit saw.
let firstExit: { code: number; stdout: string } | null;
beforeEach(() => {
  resources = [];
  bindings = [];
  server.use(...fakeControlPlane);
  stdout = "";
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    firstExit ??= { code: code ?? 0, stdout };
    throw new ExitSignal(code ?? 0);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  process.env.CREEK_API_URL = API;
  process.env.CREEK_TOKEN = "tok-test";
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CREEK_API_URL;
  delete process.env.CREEK_TOKEN;
});

type Sub = Record<string, { run?: (ctx: never) => Promise<unknown> }>;

/** Run a subcommand; its exit code and the JSON it printed. */
async function run(
  command: { subCommands?: unknown },
  sub: string,
  args: Record<string, unknown>,
): Promise<{ code: number; out: Record<string, any> }> {
  stdout = "";
  firstExit = null;
  try {
    await (command.subCommands as Sub)[sub].run!({ args } as never);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
  if (!firstExit) throw new Error("expected the command to call process.exit");
  const { code, stdout: printed } = firstExit;
  return { code, out: JSON.parse(printed) };
}

const db = (sub: string, args: Record<string, unknown>) => run(dbCommand, sub, args);

describe("create, run twice", () => {
  it.each([
    ["db", dbCommand, "database"],
    ["storage", storageCommand, "storage"],
    ["cache", cacheCommand, "cache"],
  ] as const)("creek %s create: the second run returns the existing one", async (_, cmd, kind) => {
    const first = await run(cmd, "create", { name: "thing" });
    expect(first).toMatchObject({ code: 0, out: { ok: true, alreadyExists: false } });

    const second = await run(cmd, "create", { name: "thing" });

    expect(second.code).toBe(0);
    expect(second.out).toMatchObject({
      ok: true,
      alreadyExists: true,
      resource: { id: first.out.resource.id, kind, name: "thing" },
    });
    expect(resources).toHaveLength(1);
  });

  it("a name held by another kind still fails, saying what holds it", async () => {
    const cache = seed("cache", "thing");

    const { code, out } = await db("create", { name: "thing" });

    expect(code).toBe(1);
    expect(out).toMatchObject({
      ok: false,
      error: "create_failed",
      apiError: "conflict",
      details: { existing: { id: cache.id, kind: "cache" } },
    });
  });

  it("a name a deleted resource still holds fails, it isn't 'already there'", async () => {
    seed("database", "thing", "deleted");

    const { code, out } = await db("create", { name: "thing" });

    expect(code).toBe(1);
    expect(out).toMatchObject({
      ok: false,
      error: "create_failed",
      details: { existing: { status: "deleted" } },
    });
  });
});

describe("attach, run twice", () => {
  it("the second run reports the binding that is already there", async () => {
    const res = seed("database", "mydb");
    const args = { name: "mydb", to: "app", as: "DB" };
    expect((await db("attach", args)).out).toMatchObject({ ok: true, alreadyExists: false });

    const second = await db("attach", args);

    expect(second.code).toBe(0);
    expect(second.out).toEqual({
      ok: true,
      alreadyExists: true,
      binding: { project: "app", bindingName: "DB", resourceId: res.id },
    });
  });

  it("a binding name held by another resource still fails, saying which", async () => {
    const other = seed("database", "other");
    seed("database", "mydb");
    bindings.push({ projectId: "proj-app", bindingName: "DB", resourceId: other.id, createdAt: 2 });

    const { code, out } = await db("attach", { name: "mydb", to: "app", as: "DB" });

    expect(code).toBe(1);
    expect(out).toMatchObject({
      ok: false,
      error: "attach_failed",
      details: { existing: { resourceId: other.id, name: "other" } },
    });
  });
});

describe("detach, run twice", () => {
  it("the second run succeeds with alreadyAbsent", async () => {
    const res = seed("database", "mydb");
    bindings.push({ projectId: "proj-app", bindingName: "DB", resourceId: res.id, createdAt: 2 });
    const args = { name: "mydb", from: "app", as: "DB" };
    expect((await db("detach", args)).out).toEqual({ ok: true, alreadyAbsent: false });

    const second = await db("detach", args);

    expect(second.code).toBe(0);
    expect(second.out).toEqual({
      ok: true,
      alreadyAbsent: true,
      message: "app has no binding env.DB; nothing was detached",
    });
  });

  it("a project that doesn't exist is still an error", async () => {
    const { code, out } = await db("detach", { name: "mydb", from: "nope", as: "DB" });

    expect(code).toBe(1);
    expect(out).toMatchObject({ ok: false, error: "detach_failed", status: 404 });
  });
});

describe("delete, run twice", () => {
  it.each([
    ["db", dbCommand, "database"],
    ["storage", storageCommand, "storage"],
    ["cache", cacheCommand, "cache"],
  ] as const)(
    "creek %s delete: the second run succeeds with alreadyAbsent",
    async (_, cmd, kind) => {
      const res = seed(kind, "thing");
      expect((await run(cmd, "delete", { name: "thing" })).out).toEqual({
        ok: true,
        alreadyAbsent: false,
      });

      const second = await run(cmd, "delete", { name: "thing" });

      expect(second.code).toBe(0);
      expect(second.out).toMatchObject({
        ok: true,
        alreadyAbsent: true,
        resource: { id: res.id, status: "deleted" },
      });
    },
  );

  it("a name the team never had is still not_found, so a typo isn't a deletion", async () => {
    seed("database", "mydb");

    const { code, out } = await db("delete", { name: "mydbb" });

    expect(code).toBe(1);
    expect(out).toMatchObject({ ok: false, error: "not_found" });
  });

  it("a delete that loses to a concurrent one reports alreadyAbsent", async () => {
    const res = seed("database", "mydb");
    server.use(
      http.delete(`${API}/resources/${res.id}`, () =>
        HttpResponse.json({ error: "not_found" }, { status: 404 }),
      ),
    );

    const { code, out } = await db("delete", { name: "mydb" });

    expect(code).toBe(0);
    expect(out).toMatchObject({ ok: true, alreadyAbsent: true });
  });

  it("--dry-run on an already-deleted one plans nothing", async () => {
    seed("database", "mydb", "deleted");

    const { code, out } = await db("delete", { name: "mydb", "dry-run": true });

    expect(code).toBe(0);
    expect(out).toMatchObject({ mode: "dry-run", wouldExecute: false, alreadyAbsent: true });
  });
});
