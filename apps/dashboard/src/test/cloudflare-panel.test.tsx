import { describe, test, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderDashboardApp, renderWithProviders } from "./render.js";
import { server } from "./mocks/server.js";
import { authClient } from "../lib/auth.js";
import {
  CloudflarePanel,
  type CloudflareStatus,
} from "../routes/_authenticated/-components/CloudflarePanel.js";

const API_URL = "http://localhost:8787";
const STATUS_URL = `${API_URL}/integrations/cloudflare`;
const TEAM = { id: "team-1", slug: "team-one" };

const CONNECTED = {
  configured: true,
  connected: true,
  accounts: [{ id: "acc-1", name: "Acme" }],
  grantedScopes: ["offline_access", "access.write"],
  connectedByUserId: "user-1",
  createdAt: Date.UTC(2026, 10, 28),
  updatedAt: Date.UTC(2026, 10, 28),
  needsReauth: false,
};

function status(body: CloudflareStatus) {
  server.use(http.get(STATUS_URL, () => HttpResponse.json(body)));
}

/** A session with no active organization (signup creates one without activating it). */
function noActiveTeam() {
  server.use(
    http.get(`${API_URL}/api/auth/get-session`, () =>
      HttpResponse.json({
        user: { id: "user-1", name: "Test User", email: "test@creek.dev", emailVerified: false },
        session: { id: "session-1", userId: "user-1", activeOrganizationId: null },
      }),
    ),
    http.get(`${API_URL}/api/auth/organization/get-full-organization`, () =>
      HttpResponse.json(null),
    ),
  );
  reloadAuthStores();
}

/** better-auth keeps session and organization state in module-level stores: refetch them for this test's mocks. */
function reloadAuthStores() {
  for (const signal of ["$sessionSignal", "$activeOrgSignal", "$listOrg"] as const) {
    authClient.$store.notify(signal);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CloudflarePanel", () => {
  test("instance without the integration says so and offers no button", async () => {
    status({ configured: false, connected: false });
    renderWithProviders(<CloudflarePanel team={TEAM} />);

    expect(await screen.findByText(/not available on this Creek instance/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Cloudflare" })).toBeNull();
  });

  test("connect asks for an authorization URL that returns to settings, then navigates to it", async () => {
    status({ configured: true, connected: false });
    let body: unknown;
    server.use(
      http.post(`${STATUS_URL}/authorize`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ url: "https://dash.cloudflare.com/oauth2/auth?x=1" });
      }),
    );
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    renderWithProviders(<CloudflarePanel team={TEAM} />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect Cloudflare" }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://dash.cloudflare.com/oauth2/auth?x=1"),
    );
    expect(body).toEqual({ returnTo: "/settings" });
  });

  test("a refused authorize shows the reason", async () => {
    status({ configured: true, connected: false });
    server.use(
      http.post(`${STATUS_URL}/authorize`, () =>
        HttpResponse.json({ error: "forbidden", message: "nope" }, { status: 403 }),
      ),
    );
    renderWithProviders(<CloudflarePanel team={TEAM} />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect Cloudflare" }));

    expect(await screen.findByText(/don't have permission/)).toBeInTheDocument();
  });

  test("connected: lists accounts and scopes, and a test reports the accounts reached", async () => {
    status(CONNECTED);
    server.use(
      http.post(`${STATUS_URL}/verify`, () =>
        HttpResponse.json({ ok: true, accounts: [{ id: "acc-1", name: "Acme" }] }),
      ),
    );
    renderWithProviders(<CloudflarePanel team={TEAM} />);

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
    expect(screen.getByText("acc-1")).toBeInTheDocument();
    expect(screen.getByText("offline_access, access.write")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/It reaches 1 account\./)).toBeInTheDocument();
  });

  test("a test that finds the grant unrenewable reloads status into the reconnect state", async () => {
    let calls = 0;
    server.use(
      http.get(STATUS_URL, () => {
        calls += 1;
        return HttpResponse.json(calls === 1 ? CONNECTED : { ...CONNECTED, needsReauth: true });
      }),
      http.post(`${STATUS_URL}/verify`, () =>
        HttpResponse.json(
          { error: "reauth_required", message: "Reconnect Cloudflare" },
          { status: 409 },
        ),
      ),
    );
    renderWithProviders(<CloudflarePanel team={TEAM} />);

    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));

    expect(await screen.findByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(screen.getByText(/expired and can't be renewed/)).toBeInTheDocument();
  });

  test("disconnect needs a confirmation, then sends DELETE and shows the disconnected state", async () => {
    let connected = true;
    let deletes = 0;
    server.use(
      http.get(STATUS_URL, () =>
        HttpResponse.json(connected ? CONNECTED : { configured: true, connected: false }),
      ),
      http.delete(STATUS_URL, () => {
        deletes += 1;
        connected = false;
        return HttpResponse.json({ ok: true, revoked: true });
      }),
    );
    renderWithProviders(<CloudflarePanel team={TEAM} />);

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(deletes).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));

    expect(await screen.findByText("Cloudflare disconnected.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Connect Cloudflare" })).toBeInTheDocument();
    expect(deletes).toBe(1);
  });

  test("a disconnect Cloudflare did not confirm tells the user to revoke it there", async () => {
    status(CONNECTED);
    server.use(http.delete(STATUS_URL, () => HttpResponse.json({ ok: true, revoked: false })));
    renderWithProviders(<CloudflarePanel team={TEAM} />);

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));

    expect(await screen.findByText(/Connected applications/)).toBeInTheDocument();
  });

  test("the callback result is shown and can be dismissed", async () => {
    status(CONNECTED);
    const dismiss = vi.fn();
    renderWithProviders(
      <CloudflarePanel team={TEAM} callback={{ error: "denied" }} onDismissCallback={dismiss} />,
    );

    expect(await screen.findByText(/declined the authorization/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismiss).toHaveBeenCalled();
  });

  test("an unknown callback error code is still shown", async () => {
    status({ configured: true, connected: false });
    renderWithProviders(<CloudflarePanel team={TEAM} callback={{ error: "weird_code" }} />);

    expect(await screen.findByText(/failed \(weird_code\)/)).toBeInTheDocument();
  });
});

describe("Settings page: Cloudflare callback", () => {
  test("?cloudflare=connected shows the result, and dismissing clears it from the URL", async () => {
    status(CONNECTED);
    const { router } = renderDashboardApp("/settings?cloudflare=connected");

    expect(await screen.findByText("Cloudflare connected.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.queryByText("Cloudflare connected.")).toBeNull();
  });

  test("?cloudflare_error=<code> shows its message", async () => {
    status({ configured: true, connected: false });
    renderDashboardApp("/settings?cloudflare_error=session_mismatch");

    expect(await screen.findByText(/different signed-in user/)).toBeInTheDocument();
  });

  test.each(["__proto__", "constructor", "toString"])(
    "an inherited name (%s) gets the unknown-code message",
    async (code) => {
      status({ configured: true, connected: false });
      renderDashboardApp(`/settings?cloudflare_error=${code}`);

      expect(
        await screen.findByText(`Connecting Cloudflare failed (${code}).`),
      ).toBeInTheDocument();
    },
  );
});

describe("Cloudflare panel: which team", () => {
  test("every request names the team the panel shows", async () => {
    const seen: string[] = [];
    const record = (request: Request) => {
      seen.push(`${request.method} ${request.headers.get("x-creek-team")}`);
    };
    let connected = true;
    server.use(
      http.get(STATUS_URL, ({ request }) => {
        record(request);
        return HttpResponse.json(connected ? CONNECTED : { configured: true, connected: false });
      }),
      http.post(`${STATUS_URL}/verify`, ({ request }) => {
        record(request);
        return HttpResponse.json({ ok: true, accounts: [] });
      }),
      http.delete(STATUS_URL, ({ request }) => {
        record(request);
        connected = false;
        return HttpResponse.json({ ok: true, revoked: true });
      }),
      http.post(`${STATUS_URL}/authorize`, ({ request }) => {
        record(request);
        return HttpResponse.json({ url: "https://dash.cloudflare.com/oauth2/auth" });
      }),
    );
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    renderWithProviders(<CloudflarePanel team={TEAM} />);

    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    await screen.findByText(/It reaches 0 accounts/);
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    await userEvent.click(await screen.findByRole("button", { name: "Connect Cloudflare" }));

    await waitFor(() => expect(seen).toContain("POST team-one"));
    expect(new Set(seen)).toEqual(new Set(["GET team-one", "POST team-one", "DELETE team-one"]));
    expect(seen.filter((s) => s === "POST team-one")).toHaveLength(2); // verify + authorize
  });

  test("with no active team, Settings uses the team the sidebar shows (the first)", async () => {
    const teams: (string | null)[] = [];
    noActiveTeam();
    server.use(
      http.get(`${API_URL}/api/auth/organization/list`, () =>
        HttpResponse.json([{ id: "org-2", name: "Second Team", slug: "second-team" }]),
      ),
      http.get(STATUS_URL, ({ request }) => {
        teams.push(request.headers.get("x-creek-team"));
        return HttpResponse.json({ configured: true, connected: false });
      }),
    );
    renderDashboardApp("/settings");

    expect(await screen.findByRole("button", { name: "Connect Cloudflare" })).toBeInTheDocument();
    expect(teams).toEqual(["second-team"]);
  });

  test("with no team at all, Settings says to select one instead of loading forever", async () => {
    noActiveTeam();
    server.use(http.get(`${API_URL}/api/auth/organization/list`, () => HttpResponse.json([])));
    renderDashboardApp("/settings");

    expect(await screen.findByText(/Select a team in the sidebar/)).toBeInTheDocument();
  });

  test("switching teams resets the panel: no leftover disconnect confirmation", async () => {
    let active = { id: "org-1", name: "Test Team", slug: "test-team" };
    server.use(
      http.get(`${API_URL}/api/auth/organization/get-full-organization`, () =>
        HttpResponse.json(active),
      ),
      http.post(`${API_URL}/api/auth/organization/set-active`, () => {
        active = { id: "org-2", name: "Second Team", slug: "second-team" };
        return HttpResponse.json(active);
      }),
    );
    status(CONNECTED);
    reloadAuthStores();
    renderDashboardApp("/settings");

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(screen.getByRole("button", { name: "Confirm disconnect" })).toBeInTheDocument();

    await authClient.organization.setActive({ organizationId: "org-2" });

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Confirm disconnect" })).toBeNull(),
    );
    expect(await screen.findByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });
});
