import { describe, test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "./render.js";
import { server } from "./mocks/server.js";
import { EnvVarsPanel } from "../routes/_authenticated/projects.$projectId.env.js";

const API_URL = "http://localhost:8787";

// The real env page body (not a copy), against MSW.
describe("env vars page: deploy targets", () => {
  test("lists each value with its target, treating a missing target as all deploys", async () => {
    server.use(
      http.get(`${API_URL}/projects/proj-1/env`, () =>
        HttpResponse.json([
          { key: "STRIPE_KEY", target: "production", value: "STRI****" },
          { key: "STRIPE_KEY", target: "preview", value: "STRI****" },
          { key: "OLD_VAR", value: "OLD_****" },
        ]),
      ),
    );
    renderWithProviders(<EnvVarsPanel projectId="proj-1" />);
    expect(await screen.findAllByText("STRIPE_KEY")).toHaveLength(2);
    // Badges in the list; the add form's <select> has the same labels.
    const badges = (label: string) =>
      screen.getAllByText(label).filter((el) => el.tagName !== "OPTION").length;
    expect(badges("Production only")).toBe(1);
    expect(badges("Previews only")).toBe(1);
    expect(badges("All deploys")).toBe(1);
  });

  test("adds a value for the chosen target", async () => {
    let posted: unknown;
    server.use(
      http.get(`${API_URL}/projects/proj-1/env`, () => HttpResponse.json([])),
      http.post(`${API_URL}/projects/proj-1/env`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json(
          { ok: true, key: "STRIPE_KEY", target: "production" },
          { status: 201 },
        );
      }),
    );
    renderWithProviders(<EnvVarsPanel projectId="proj-1" />);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText("KEY"), "stripe_key");
    await user.type(screen.getByPlaceholderText("value"), "sk_live_x");
    await user.selectOptions(screen.getByLabelText("Deploys that get this value"), "production");
    await user.click(screen.getByRole("button", { name: /add/i }));
    await waitFor(() =>
      expect(posted).toEqual({ key: "STRIPE_KEY", value: "sk_live_x", target: "production" }),
    );
  });

  test("removes only the clicked target's value", async () => {
    let deleted = "";
    server.use(
      http.get(`${API_URL}/projects/proj-1/env`, () =>
        HttpResponse.json([
          { key: "STRIPE_KEY", target: "all", value: "STRI****" },
          { key: "STRIPE_KEY", target: "production", value: "STRI****" },
        ]),
      ),
      http.delete(`${API_URL}/projects/proj-1/env/STRIPE_KEY`, ({ request }) => {
        deleted = request.url;
        return HttpResponse.json({ ok: true, removed: 1 });
      }),
    );
    renderWithProviders(<EnvVarsPanel projectId="proj-1" />);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Remove STRIPE_KEY (Production only)"));
    await waitFor(() => expect(new URL(deleted).searchParams.get("target")).toBe("production"));
  });
});
