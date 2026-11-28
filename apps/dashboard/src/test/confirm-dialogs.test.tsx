import { describe, test, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderDashboardApp, renderWithProviders } from "./render.js";
import { server } from "./mocks/server.js";
import { ApiProvider } from "@/lib/api-context";
import { BindingsPanel } from "@/routes/_authenticated/-components/BindingsPanel";

const API_URL = "http://localhost:8787";

const RESOURCE = {
  id: "res-1",
  teamId: "org-1",
  kind: "database",
  name: "main-db",
  cfResourceId: null,
  cfResourceType: "d1",
  status: "active",
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

/** Counts the requests a handler receives, so a test can assert one never arrived. */
function counter() {
  const calls: string[] = [];
  return {
    calls,
    record: (url: string) => {
      calls.push(url);
      return HttpResponse.json({ ok: true });
    },
  };
}

/**
 * Opens the confirm dialog with `trigger` and checks it is a modal alert
 * dialog whose Cancel button has focus, so Enter does not confirm.
 */
async function openDialog(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
  await user.click(trigger);
  const dialog = await screen.findByRole("alertdialog");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus());
  return dialog;
}

describe("ResourcesPanel: delete a resource", () => {
  function mockResource(del: ReturnType<typeof counter>) {
    server.use(
      http.get(`${API_URL}/resources`, () => HttpResponse.json({ resources: [RESOURCE] })),
      http.get(`${API_URL}/resources/res-1`, () =>
        HttpResponse.json({ ...RESOURCE, bindings: [] }),
      ),
      http.delete(`${API_URL}/resources/res-1`, ({ request }) => del.record(request.url)),
    );
  }

  test("cancelling the dialog deletes nothing", async () => {
    const del = counter();
    mockResource(del);
    const user = userEvent.setup();
    renderDashboardApp("/resources/database");

    await screen.findByRole("link", { name: "main-db" });
    const dialog = await openDialog(user, screen.getByRole("button", { name: "Delete" }));
    expect(within(dialog).getByText('Delete "main-db"?')).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(del.calls).toHaveLength(0);
  });

  test("confirming the dialog deletes the resource once", async () => {
    const del = counter();
    mockResource(del);
    const user = userEvent.setup();
    renderDashboardApp("/resources/database");

    await screen.findByRole("link", { name: "main-db" });
    const dialog = await openDialog(user, screen.getByRole("button", { name: "Delete" }));
    expect(del.calls).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(del.calls).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});

describe("BindingsPanel: detach a binding", () => {
  function mockBinding(detach: ReturnType<typeof counter>) {
    server.use(
      http.get(`${API_URL}/resources`, () => HttpResponse.json({ resources: [] })),
      http.get(`${API_URL}/projects/my-site/bindings`, () =>
        HttpResponse.json({
          bindings: [
            {
              bindingName: "DB",
              resourceId: "res-1",
              kind: "database",
              name: "main-db",
              status: "active",
              createdAt: 1700000000000,
            },
          ],
        }),
      ),
      http.delete(`${API_URL}/projects/my-site/bindings/DB`, ({ request }) =>
        detach.record(request.url),
      ),
    );
  }

  function renderPanel() {
    renderWithProviders(
      <ApiProvider>
        <BindingsPanel projectId="my-site" />
      </ApiProvider>,
    );
  }

  test("cancelling the dialog detaches nothing", async () => {
    const detach = counter();
    mockBinding(detach);
    const user = userEvent.setup();
    renderPanel();

    const dialog = await openDialog(user, await screen.findByRole("button", { name: "Detach" }));
    expect(within(dialog).getByText("Detach env.DB?")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(detach.calls).toHaveLength(0);
  });

  test("confirming the dialog detaches the binding once", async () => {
    const detach = counter();
    mockBinding(detach);
    const user = userEvent.setup();
    renderPanel();

    const dialog = await openDialog(user, await screen.findByRole("button", { name: "Detach" }));
    expect(detach.calls).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(detach.calls).toHaveLength(1));
  });
});

describe("Resource detail: detach from a project", () => {
  function mockResourceDetail(detach: ReturnType<typeof counter>) {
    server.use(
      http.get(`${API_URL}/resources/res-1`, () =>
        HttpResponse.json({
          ...RESOURCE,
          bindings: [{ projectId: "p1", projectSlug: "my-site", bindingName: "DB" }],
        }),
      ),
      http.get(`${API_URL}/resources/res-1/metrics`, () => HttpResponse.json({})),
      http.delete(`${API_URL}/projects/my-site/bindings/DB`, ({ request }) =>
        detach.record(request.url),
      ),
    );
  }

  test("cancelling the dialog detaches nothing", async () => {
    const detach = counter();
    mockResourceDetail(detach);
    const user = userEvent.setup();
    renderDashboardApp("/resources/res-1");

    const dialog = await openDialog(user, await screen.findByRole("button", { name: "Detach" }));
    expect(within(dialog).getByText("Detach env.DB from my-site?")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(detach.calls).toHaveLength(0);
  });

  test("confirming the dialog detaches the binding once", async () => {
    const detach = counter();
    mockResourceDetail(detach);
    const user = userEvent.setup();
    renderDashboardApp("/resources/res-1");

    const dialog = await openDialog(user, await screen.findByRole("button", { name: "Detach" }));
    expect(detach.calls).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(detach.calls).toHaveLength(1));
  });
});
