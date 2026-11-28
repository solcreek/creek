import { describe, test, expect, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderDashboardApp, renderWithProviders } from "./render.js";
import { server } from "./mocks/server.js";
import { ApiProvider } from "@/lib/api-context";
import {
  DomainsPanel,
  type CustomDomain,
} from "../routes/_authenticated/-components/DomainsPanel.js";

const API_URL = "http://localhost:8787";
const BASE = `${API_URL}/projects/my-site/domains`;
const TARGET = "cname.bycreek.com";

type Call = { method: string; path: string; body?: unknown };

// A stand-in for the control plane's domain routes, with the same rules:
// a project's first domain is primary, removing the primary promotes the
// oldest active domain, and redirectToPrimaryDomain lives on the project.
let rows: CustomDomain[];
let redirect: number;
let calls: Call[];

function row(hostname: string, status: string, isPrimary: number, createdAt: number) {
  return { id: `dom-${hostname}`, projectId: "p1", hostname, status, isPrimary, createdAt };
}

function dns(hostname: string) {
  return {
    cname: { name: hostname, target: TARGET },
    apex: false,
    records: [
      { type: "CNAME", name: hostname, value: TARGET, purpose: "Routes the domain to Creek." },
    ],
  };
}

function controlPlane() {
  server.use(
    http.get(BASE, () => HttpResponse.json(rows)),
    http.get(`${API_URL}/projects/my-site`, () =>
      HttpResponse.json({ id: "p1", slug: "my-site", redirectToPrimaryDomain: redirect }),
    ),
    http.get(`${BASE}/:id`, ({ params }) => {
      calls.push({ method: "GET", path: `/domains/${params.id}` });
      const found = rows.find((r) => r.id === params.id);
      if (!found) return HttpResponse.json({ error: "not_found" }, { status: 404 });
      return HttpResponse.json({ ...found, dns: dns(found.hostname) });
    }),
    http.post(BASE, async ({ request }) => {
      const body = (await request.json()) as { hostname: string };
      calls.push({ method: "POST", path: "/domains", body });
      const domain = row(body.hostname, "pending", rows.length === 0 ? 1 : 0, 100 + rows.length);
      rows = [domain, ...rows];
      return HttpResponse.json({ domain, verification: dns(domain.hostname) }, { status: 201 });
    }),
    http.patch(BASE, async ({ request }) => {
      const body = (await request.json()) as { redirectToPrimary: boolean };
      calls.push({ method: "PATCH", path: "/domains", body });
      redirect = body.redirectToPrimary ? 1 : 0;
      const primary = rows.find((r) => r.isPrimary) ?? null;
      return HttpResponse.json({ ok: true, redirectToPrimary: body.redirectToPrimary, primary });
    }),
    http.post(`${BASE}/:id/primary`, ({ params }) => {
      calls.push({ method: "POST", path: `/domains/${params.id}/primary` });
      rows = rows.map((r) => ({ ...r, isPrimary: r.id === params.id ? 1 : 0 }));
      const domain = rows.find((r) => r.id === params.id)!;
      return HttpResponse.json({ ok: true, changed: true, domain });
    }),
    http.post(`${BASE}/:id/activate`, ({ params }) => {
      calls.push({ method: "POST", path: `/domains/${params.id}/activate` });
      return HttpResponse.json({
        ok: false,
        status: "pending_dns",
        message: `Domain not verified yet (edge status: pending). Point DNS to ${TARGET}, then retry.`,
      });
    }),
    http.delete(`${BASE}/:id`, ({ params }) => {
      calls.push({ method: "DELETE", path: `/domains/${params.id}` });
      const removed = rows.find((r) => r.id === params.id);
      rows = rows.filter((r) => r.id !== params.id);
      if (removed?.isPrimary && rows.length) {
        const next = [...rows].sort(
          (a, b) =>
            Number(b.status === "active") - Number(a.status === "active") ||
            a.createdAt - b.createdAt,
        )[0];
        rows = rows.map((r) => ({ ...r, isPrimary: r.id === next.id ? 1 : 0 }));
      }
      return HttpResponse.json({ ok: true });
    }),
  );
}

beforeEach(() => {
  rows = [];
  redirect = 1;
  calls = [];
});

function renderPanel() {
  return renderWithProviders(
    <ApiProvider>
      <DomainsPanel projectId="my-site" />
    </ApiProvider>,
  );
}

/** The list item of one domain. */
async function domainRow(hostname: string) {
  const list = await screen.findByRole("list", { name: "Custom domains" });
  const item = within(list)
    .getAllByRole("listitem")
    .find((li) => within(li).queryAllByText(hostname).length > 0);
  if (!item) throw new Error(`no row for ${hostname}`);
  return item;
}

describe("domains page", () => {
  test("lists each domain with its status, and marks the primary one", async () => {
    rows = [
      row("www.example.com", "pending", 0, 2),
      row("app.example.com", "active", 1, 1),
      row("old.example.com", "failed", 0, 0),
    ];
    controlPlane();
    renderPanel();

    const app = await domainRow("app.example.com");
    expect(within(app).getByText("Active")).toBeInTheDocument();
    expect(within(app).getByText("Primary")).toBeInTheDocument();
    // Already active and primary: nothing to activate, nothing to promote.
    expect(within(app).queryByRole("button", { name: "Activate" })).toBeNull();
    expect(within(app).queryByRole("button", { name: "Make primary" })).toBeNull();

    const www = await domainRow("www.example.com");
    expect(within(www).getByText("Pending")).toBeInTheDocument();
    expect(within(www).queryByText("Primary")).toBeNull();
    expect(within(www).getByRole("button", { name: "Activate" })).toBeInTheDocument();

    const old = await domainRow("old.example.com");
    expect(within(old).getByText("Failed")).toBeInTheDocument();

    // The redirect setting reads the project, and says what it acts on now.
    expect(
      await screen.findByText("The default hostname redirects to app.example.com."),
    ).toBeInTheDocument();
  });

  test("adding posts the hostname, refreshes the list and shows the DNS record to set", async () => {
    controlPlane();
    renderPanel();
    const user = userEvent.setup();

    expect(await screen.findByText("No custom domains")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Domain"), "  shop.example.com ");
    await user.click(screen.getByRole("button", { name: "Add domain" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/domains",
        body: { hostname: "shop.example.com" },
      }),
    );
    const shop = await domainRow("shop.example.com");
    expect(within(shop).getByText("Pending")).toBeInTheDocument();
    expect(within(shop).getByText("Primary")).toBeInTheDocument();
    expect(screen.getByLabelText("Domain")).toHaveValue("");

    // The new domain's records open on their own, each with a copy button.
    expect(await within(shop).findByText(TARGET)).toBeInTheDocument();
    await user.click(within(shop).getByRole("button", { name: `Copy target ${TARGET}` }));
    expect(await navigator.clipboard.readText()).toBe(TARGET);
  });

  test("an add the API refuses shows its message", async () => {
    controlPlane();
    server.use(
      http.post(BASE, () =>
        HttpResponse.json(
          { error: "conflict", message: "Hostname already in use by another project" },
          { status: 409 },
        ),
      ),
    );
    renderPanel();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Domain"), "taken.example.com");
    await user.click(screen.getByRole("button", { name: "Add domain" }));

    expect(
      await screen.findByText(/Hostname already in use by another project/),
    ).toBeInTheDocument();
  });

  test("removing asks for confirmation in a dialog before it deletes", async () => {
    rows = [row("app.example.com", "active", 1, 1), row("www.example.com", "pending", 0, 2)];
    controlPlane();
    renderPanel();
    const user = userEvent.setup();

    const app = await domainRow("app.example.com");
    await user.click(within(app).getByRole("button", { name: "Remove app.example.com" }));

    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Remove app.example.com?")).toBeInTheDocument();
    // Removing the primary says which domain takes over.
    expect(
      within(dialog).getByText(/www\.example\.com becomes the primary one/),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);

    // Cancel deletes nothing.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);

    await user.click(within(app).getByRole("button", { name: "Remove app.example.com" }));
    dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove domain" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls).toContainEqual({ method: "DELETE", path: "/domains/dom-app.example.com" });
    await waitFor(() => expect(screen.queryByText("app.example.com")).toBeNull());
    // The remaining domain took over as primary.
    const www = await domainRow("www.example.com");
    expect(await within(www).findByText("Primary")).toBeInTheDocument();
  });

  test("removing a domain with its DNS records open does not ask for it again", async () => {
    rows = [row("app.example.com", "active", 1, 1), row("www.example.com", "pending", 0, 2)];
    controlPlane();
    renderPanel();
    const user = userEvent.setup();

    const www = await domainRow("www.example.com");
    await user.click(within(www).getByRole("button", { name: "DNS records" }));
    expect(await within(www).findByText(TARGET)).toBeInTheDocument();

    await user.click(within(www).getByRole("button", { name: "Remove www.example.com" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove domain" }),
    );
    await waitFor(() => expect(screen.queryByText("www.example.com")).toBeNull());

    const deleted = calls.findIndex((c) => c.method === "DELETE");
    expect(deleted).toBeGreaterThan(-1);
    expect(calls.slice(deleted).filter((c) => c.method === "GET")).toEqual([]);
  });

  test("a failed remove keeps the dialog open with the reason", async () => {
    rows = [row("app.example.com", "active", 1, 1)];
    controlPlane();
    server.use(
      http.delete(`${BASE}/:id`, () =>
        HttpResponse.json({ error: "forbidden", message: "Forbidden" }, { status: 403 }),
      ),
    );
    renderPanel();
    const user = userEvent.setup();

    const app = await domainRow("app.example.com");
    await user.click(within(app).getByRole("button", { name: "Remove app.example.com" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove domain" }));

    expect(await within(dialog).findByText(/don't have permission/)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  test("make primary and the redirect switch call their endpoints", async () => {
    rows = [row("www.example.com", "pending", 0, 2), row("app.example.com", "active", 1, 1)];
    controlPlane();
    renderPanel();
    const user = userEvent.setup();

    const www = await domainRow("www.example.com");
    await user.click(within(www).getByRole("button", { name: "Make primary" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/domains/dom-www.example.com/primary",
      }),
    );
    expect(await within(www).findByText("Primary")).toBeInTheDocument();
    // A pending primary doesn't redirect yet, and the page says so.
    expect(
      await screen.findByText("www.example.com is pending: the redirect starts once it is active."),
    ).toBeInTheDocument();

    const toggle = screen.getByRole("switch", { name: "Redirect the default hostname" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PATCH",
        path: "/domains",
        body: { redirectToPrimary: false },
      }),
    );
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  test("activate reports pending DNS honestly instead of claiming success", async () => {
    rows = [row("app.example.com", "pending", 1, 1)];
    controlPlane();
    renderPanel();
    const user = userEvent.setup();

    const app = await domainRow("app.example.com");
    await user.click(within(app).getByRole("button", { name: "Activate" }));

    expect(await within(app).findByText(/Domain not verified yet/)).toBeInTheDocument();
    expect(calls).toContainEqual({ method: "POST", path: "/domains/dom-app.example.com/activate" });
    expect(within(app).getByText("Pending")).toBeInTheDocument();
  });

  test("a failed list shows the API error, not the empty state", async () => {
    controlPlane();
    server.use(
      http.get(BASE, () =>
        HttpResponse.json({ error: "not_found", message: "Project not found" }, { status: 404 }),
      ),
    );
    renderPanel();

    expect(await screen.findByText("Project not found")).toBeInTheDocument();
    expect(screen.queryByText("No custom domains")).toBeNull();
  });

  test("a failed project read shows the error instead of an off switch", async () => {
    controlPlane();
    server.use(
      http.get(`${API_URL}/projects/my-site`, () =>
        HttpResponse.json({ error: "internal", message: "Database unavailable" }, { status: 500 }),
      ),
    );
    renderPanel();

    expect(await screen.findByText(/Database unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("project tabs", () => {
  test("the Domains tab opens the domains page", async () => {
    rows = [row("app.example.com", "active", 1, 1)];
    controlPlane();
    const user = userEvent.setup();
    renderDashboardApp("/projects/my-site/env");

    await user.click(await screen.findByRole("link", { name: "Domains" }));

    expect(await screen.findByText("app.example.com")).toBeInTheDocument();
  });
});
