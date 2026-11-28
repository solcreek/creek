import { describe, test, expect } from "vitest";
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "./render.js";
import { server } from "./mocks/server.js";
import { ApiProvider } from "@/lib/api-context";
import { BindingsPanel } from "@/routes/_authenticated/-components/BindingsPanel";

const API_URL = "http://localhost:8787";

// A failed read must not render as an empty list: "No resources attached"
// after a 404 tells the user something false about their project.
describe("BindingsPanel", () => {
  test("shows the API error, not the empty state, when bindings fail to load", async () => {
    server.use(
      http.get(`${API_URL}/resources`, () => HttpResponse.json({ resources: [] })),
      http.get(`${API_URL}/projects/my-site/bindings`, () =>
        HttpResponse.json({ error: "not_found", message: "Project not found" }, { status: 404 }),
      ),
    );

    renderWithProviders(
      <ApiProvider>
        <BindingsPanel projectId="my-site" />
      </ApiProvider>,
    );

    expect(await screen.findByText("Project not found")).toBeInTheDocument();
    expect(screen.queryByText(/No resources attached/)).not.toBeInTheDocument();
  });

  test("shows the empty state when the project has no bindings", async () => {
    server.use(
      http.get(`${API_URL}/resources`, () => HttpResponse.json({ resources: [] })),
      http.get(`${API_URL}/projects/my-site/bindings`, () => HttpResponse.json({ bindings: [] })),
    );

    renderWithProviders(
      <ApiProvider>
        <BindingsPanel projectId="my-site" />
      </ApiProvider>,
    );

    expect(await screen.findByText(/No resources attached/)).toBeInTheDocument();
  });
});
