import { describe, test, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderDashboardApp } from "./render.js";
import { server } from "./mocks/server.js";
import {
  splitList,
  type AccessStatus,
} from "../routes/_authenticated/-components/ProtectionPanel.js";

const API_URL = "http://localhost:8787";
const ACCESS_URL = `${API_URL}/projects/proj-1/access`;
const ACCOUNT = "a".repeat(32);

const CONNECTED = {
  configured: true,
  connected: true,
  accounts: [{ id: ACCOUNT, name: "Acme" }],
  grantedScopes: ["access.write"],
  connectedByUserId: "user-1",
  createdAt: 0,
  updatedAt: 0,
  needsReauth: false,
};

const MANAGED: AccessStatus = {
  protected: true,
  teamDomain: "acme.cloudflareaccess.com",
  aud: "ab".repeat(32),
  bypassPaths: ["/health"],
  hostnames: ["app.acme.com"],
  managed: {
    accountId: ACCOUNT,
    emails: ["guest@partner.io"],
    emailDomains: ["acme.com"],
    teamMembers: true,
    memberEmails: ["owner@acme.com"],
    outOfSync: { hostnames: false, members: false },
  },
  noMailDomains: [],
  noMxDomains: [],
};

function mock(access: AccessStatus, cloudflare: object = CONNECTED) {
  server.use(
    http.get(ACCESS_URL, () => HttpResponse.json(access)),
    http.get(`${API_URL}/integrations/cloudflare`, () => HttpResponse.json(cloudflare)),
  );
}

async function openPanel() {
  renderDashboardApp("/projects/proj-1/settings");
  const heading = await screen.findByRole("heading", { name: "Protection" });
  return within(heading.closest("section")!);
}

describe("ProtectionPanel", () => {
  test("without a custom domain it says to add one first", async () => {
    mock({ protected: false, hostnames: [] });
    const panel = await openPanel();
    expect(await panel.findByText(/Add a custom domain first/)).toBeInTheDocument();
    expect(panel.queryByRole("button", { name: /Protect/ })).toBeNull();
  });

  test("without a Cloudflare connection it points to Settings", async () => {
    mock({ protected: false, hostnames: ["app.acme.com"] }, { configured: true, connected: false });
    const panel = await openPanel();
    expect(await panel.findByRole("link", { name: "Settings → Cloudflare" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(panel.queryByRole("button", { name: /Protect/ })).toBeNull();
  });

  test("turning it on sends who may sign in and the public paths", async () => {
    let body: unknown;
    mock({ protected: false, hostnames: ["app.acme.com"] });
    server.use(
      http.put(`${ACCESS_URL}/managed`, async ({ request }) => {
        body = await request.json();
        mock(MANAGED);
        return HttpResponse.json({ ok: true });
      }),
    );
    const panel = await openPanel();

    await userEvent.click(
      await panel.findByRole("button", { name: "Protect with Cloudflare Access" }),
    );
    expect(panel.getByRole("checkbox", { name: "Everyone on this team" })).toBeChecked();
    await userEvent.type(panel.getByLabelText("Other people's emails"), "a@x.io, b@y.io");
    await userEvent.type(panel.getByLabelText("Public paths"), "/health");
    await userEvent.click(panel.getByRole("button", { name: "Turn on protection" }));

    expect(await panel.findByText("Protected by Cloudflare Access")).toBeInTheDocument();
    expect(body).toEqual({
      accountId: ACCOUNT,
      emails: ["a@x.io", "b@y.io"],
      emailDomains: [],
      teamMembers: true,
      bypassPaths: ["/health"],
    });
  });

  test("nobody to let in is refused before anything is sent", async () => {
    let puts = 0;
    mock({ protected: false, hostnames: ["app.acme.com"] });
    server.use(
      http.put(`${ACCESS_URL}/managed`, () => {
        puts += 1;
        return HttpResponse.json({ ok: true });
      }),
    );
    const panel = await openPanel();

    await userEvent.click(
      await panel.findByRole("button", { name: "Protect with Cloudflare Access" }),
    );
    await userEvent.click(panel.getByRole("checkbox", { name: "Everyone on this team" }));
    await userEvent.click(panel.getByRole("button", { name: "Turn on protection" }));

    expect(await panel.findByText(/Say who can sign in/)).toBeInTheDocument();
    expect(puts).toBe(0);
  });

  test("a refusal with a Cloudflare setup link shows the link", async () => {
    mock({ protected: false, hostnames: ["app.acme.com"] });
    const setupUrl = `https://dash.cloudflare.com/${ACCOUNT}/one/onboarding`;
    server.use(
      http.put(`${ACCESS_URL}/managed`, () =>
        HttpResponse.json(
          { error: "zero_trust_setup_required", message: "Set up Zero Trust first.", setupUrl },
          { status: 409 },
        ),
      ),
    );
    const panel = await openPanel();

    await userEvent.click(
      await panel.findByRole("button", { name: "Protect with Cloudflare Access" }),
    );
    await userEvent.click(panel.getByRole("button", { name: "Turn on protection" }));

    expect(await panel.findByText("Set up Zero Trust first.")).toBeInTheDocument();
    expect(panel.getByRole("link", { name: /Open Cloudflare/ })).toHaveAttribute("href", setupUrl);
  });

  test("a managed setup lists everyone who can sign in and explains the PIN", async () => {
    mock(MANAGED);
    const panel = await openPanel();

    expect(await panel.findByText("Everyone on this team")).toBeInTheDocument();
    expect(panel.getByText("owner@acme.com")).toBeInTheDocument();
    expect(panel.getByText("guest@partner.io")).toBeInTheDocument();
    expect(panel.getByText("@acme.com")).toBeInTheDocument();
    expect(panel.getByText("/health")).toBeInTheDocument();
    expect(
      panel.getByText(/Cloudflare sends it only to addresses on this list/),
    ).toBeInTheDocument();
    expect(panel.queryByRole("button", { name: "Update Cloudflare" })).toBeNull();
  });

  test("domains that cannot receive mail are named", async () => {
    mock({ ...MANAGED, noMailDomains: ["gone.dev"] } as AccessStatus);
    const panel = await openPanel();
    expect(await panel.findByText(/cannot receive email/)).toBeInTheDocument();
    expect(panel.getByText("gone.dev")).toBeInTheDocument();
    expect(panel.queryByText(/no mail server \(MX\) record/)).toBeNull();
  });

  test("domains without an MX record get the softer warning", async () => {
    mock({ ...MANAGED, noMxDomains: ["creek.dev"] } as AccessStatus);
    const panel = await openPanel();
    expect(await panel.findByText(/no mail server \(MX\) record/)).toBeInTheDocument();
    expect(panel.getByText("creek.dev")).toBeInTheDocument();
    expect(panel.queryByText(/cannot receive email/)).toBeNull();
  });

  test("out of sync: one click sends the current settings again", async () => {
    let body: unknown;
    const stale = {
      ...MANAGED,
      managed: { ...(MANAGED as any).managed, outOfSync: { hostnames: true, members: true } },
    } as AccessStatus;
    mock(stale);
    server.use(
      http.put(`${ACCESS_URL}/managed`, async ({ request }) => {
        body = await request.json();
        mock(MANAGED);
        return HttpResponse.json({ ok: true });
      }),
    );
    const panel = await openPanel();

    expect(await panel.findByText(/custom domains and team members changed/)).toBeInTheDocument();
    await userEvent.click(panel.getByRole("button", { name: "Update Cloudflare" }));

    await waitFor(() =>
      expect(panel.queryByRole("button", { name: "Update Cloudflare" })).toBeNull(),
    );
    expect(body).toEqual({
      accountId: ACCOUNT,
      emails: ["guest@partner.io"],
      emailDomains: ["acme.com"],
      teamMembers: true,
      bypassPaths: ["/health"],
    });
  });

  test("edit starts from the saved settings", async () => {
    mock(MANAGED);
    const panel = await openPanel();

    await userEvent.click(await panel.findByRole("button", { name: "Edit" }));
    expect(panel.getByLabelText("Other people's emails")).toHaveValue("guest@partner.io");
    expect(panel.getByLabelText("Everyone with an email on these domains")).toHaveValue("acme.com");
    expect(panel.getByLabelText("Public paths")).toHaveValue("/health");
    expect(panel.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  test("turning it off needs a confirmation and reports applications left behind", async () => {
    let deletes = 0;
    mock(MANAGED);
    server.use(
      http.delete(ACCESS_URL, () => {
        deletes += 1;
        mock({ protected: false, hostnames: ["app.acme.com"] });
        return HttpResponse.json({
          ok: true,
          protected: false,
          cloudflareCleanup: {
            ok: false,
            message: "Protection is off, but Creek could not delete its Access applications.",
            accountId: ACCOUNT,
            appIds: ["app-1"],
          },
        });
      }),
    );
    const panel = await openPanel();

    await userEvent.click(await panel.findByRole("button", { name: "Turn off protection" }));
    expect(deletes).toBe(0);
    await userEvent.click(panel.getByRole("button", { name: "Confirm: turn off protection" }));

    expect(await panel.findByText(/could not delete its Access applications/)).toBeInTheDocument();
    expect(panel.getByText("app-1")).toBeInTheDocument();
    expect(
      await panel.findByRole("button", { name: "Protect with Cloudflare Access" }),
    ).toBeInTheDocument();
    expect(deletes).toBe(1);
  });

  test("a customer-made application is shown, and Creek can take it over", async () => {
    mock({ ...MANAGED, managed: null } as AccessStatus);
    const panel = await openPanel();

    expect(await panel.findByText(/Access application you made/)).toBeInTheDocument();
    expect(panel.getByText("ab".repeat(32))).toBeInTheDocument();
    await userEvent.click(panel.getByRole("button", { name: "Let Creek manage it" }));
    expect(panel.getByRole("button", { name: "Turn on protection" })).toBeInTheDocument();
  });
});

describe("splitList", () => {
  test("splits on lines and commas, trims, drops empties", () => {
    expect(splitList(" a@x.io,\n\n b@y.io ,")).toEqual(["a@x.io", "b@y.io"]);
  });
});
