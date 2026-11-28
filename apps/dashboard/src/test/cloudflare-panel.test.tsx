import { describe, test, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderDashboardApp, renderWithProviders } from "./render.js";
import { server } from "./mocks/server.js";
import {
  CloudflarePanel,
  type CloudflareStatus,
} from "../routes/_authenticated/-components/CloudflarePanel.js";

const API_URL = "http://localhost:8787";
const STATUS_URL = `${API_URL}/integrations/cloudflare`;

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CloudflarePanel", () => {
  test("instance without the integration says so and offers no button", async () => {
    status({ configured: false, connected: false });
    renderWithProviders(<CloudflarePanel teamId="team-1" />);

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

    renderWithProviders(<CloudflarePanel teamId="team-1" />);
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
    renderWithProviders(<CloudflarePanel teamId="team-1" />);
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
    renderWithProviders(<CloudflarePanel teamId="team-1" />);

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
    renderWithProviders(<CloudflarePanel teamId="team-1" />);

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
    renderWithProviders(<CloudflarePanel teamId="team-1" />);

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
    renderWithProviders(<CloudflarePanel teamId="team-1" />);

    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));

    expect(await screen.findByText(/Connected applications/)).toBeInTheDocument();
  });

  test("the callback result is shown and can be dismissed", async () => {
    status(CONNECTED);
    const dismiss = vi.fn();
    renderWithProviders(
      <CloudflarePanel
        teamId="team-1"
        callback={{ error: "denied" }}
        onDismissCallback={dismiss}
      />,
    );

    expect(await screen.findByText(/declined the authorization/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismiss).toHaveBeenCalled();
  });

  test("an unknown callback error code is still shown", async () => {
    status({ configured: true, connected: false });
    renderWithProviders(<CloudflarePanel teamId="team-1" callback={{ error: "weird_code" }} />);

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
});
