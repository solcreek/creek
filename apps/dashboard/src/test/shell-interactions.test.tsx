import { describe, test, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CatchBoundary,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { ApiProvider } from "@/lib/api-context";
import { RouteErrorFallback } from "@/components/route-error";
import { renderDashboardApp } from "./render.js";
import { server } from "./mocks/server.js";

const API_URL = "http://localhost:8787";

describe("dashboard shell interactions", () => {
  test("opens TeamSwitcher dropdown without Base UI errors", async () => {
    const user = userEvent.setup();
    renderDashboardApp("/projects");

    const trigger = await screen.findByRole("button", { name: /Test Team/i });
    await user.click(trigger);

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Teams")).toBeInTheDocument();
    expect(within(menu).getByText("Second Team")).toBeInTheDocument();
    expect(within(menu).getByText("Create team")).toBeInTheDocument();
  });

  test("opens UserFooter dropdown and navigates via menu item", async () => {
    const user = userEvent.setup();
    renderDashboardApp("/projects");

    const trigger = await screen.findByRole("button", { name: /Test User/i });
    await user.click(trigger);

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("test@creek.dev")).toBeInTheDocument();
    expect(within(menu).getByText("Settings")).toBeInTheDocument();
    expect(within(menu).getByText("API Keys")).toBeInTheDocument();
    expect(within(menu).getByText("Sign out")).toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: /API Keys/i }));
    expect(await screen.findByRole("heading", { name: "API Keys" })).toBeInTheDocument();
  });

  test("opens ProjectSwitcher dropdown and lists projects", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${API_URL}/projects`, () =>
        HttpResponse.json([{ id: "p1", slug: "demo-app", framework: "vite-react" }]),
      ),
    );

    renderDashboardApp("/projects");

    const trigger = await screen.findByRole("button", { name: /All Projects/i });
    await user.click(trigger);

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByPlaceholderText("Find Project...")).toBeInTheDocument();
    expect(within(menu).getByText("demo-app")).toBeInTheDocument();
    expect(within(menu).getByText("Create Project")).toBeInTheDocument();
  });

  test("opens NewProjectDialog from projects page", async () => {
    const user = userEvent.setup();
    renderDashboardApp("/projects");

    const trigger = await screen.findByRole("button", { name: /New Project/i });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Create Project", { selector: "h2" })).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText("my-app")).toBeInTheDocument();
  });

  test("opens deployment row DropdownMenu on project page", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${API_URL}/projects/demo-app`, () =>
        HttpResponse.json({
          id: "p1",
          slug: "demo-app",
          productionDeploymentId: "d-prod",
          githubRepo: null,
        }),
      ),
      http.get(`${API_URL}/projects/demo-app/deployments`, () =>
        HttpResponse.json([
          {
            id: "d-2",
            version: 2,
            status: "active",
            branch: "main",
            commitSha: null,
            commitMessage: null,
            triggerType: "cli",
            failedStep: null,
            errorMessage: null,
            createdAt: 1700000000000,
            url: null,
          },
        ]),
      ),
    );

    renderDashboardApp("/projects/demo-app");

    const versionLabel = await screen.findByText("v2");
    const row = versionLabel.closest(".rounded-lg") as HTMLElement;
    const menuTrigger = within(row)
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-haspopup") === "menu");

    expect(menuTrigger).toBeDefined();
    await user.click(menuTrigger!);

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Promote to Production")).toBeInTheDocument();
  });

  test("navigates across sidebar routes without errors", async () => {
    const user = userEvent.setup();
    renderDashboardApp("/projects");

    await screen.findByRole("heading", { name: "Projects", level: 1 });
    const sidebar = document.querySelector('[data-sidebar="sidebar"]') as HTMLElement;
    expect(sidebar).toBeTruthy();

    const targets = [
      { link: "Database", heading: "Database" },
      { link: "Storage", heading: "Storage" },
      { link: "Cache", heading: "Cache" },
      { link: "AI", heading: "AI" },
      { link: "Settings", heading: "Settings" },
      { link: "API Keys", heading: "API Keys" },
      { link: "Projects", heading: "Projects" },
    ];

    for (const target of targets) {
      await user.click(within(sidebar).getByRole("link", { name: target.link }));
      expect(
        await screen.findByRole("heading", { name: target.heading, level: 1 }),
      ).toBeInTheDocument();
    }
  });

  test("error boundary catches runtime crashes and recovers on Try again", async () => {
    const user = userEvent.setup();
    let shouldThrow = true;

    function MaybeCrashPage() {
      if (shouldThrow) {
        throw new Error("Boom in page");
      }
      return <h1>Recovered Page</h1>;
    }

    const rootRoute = createRootRoute({
      component: () => (
        <CatchBoundary getResetKey={() => "test"} errorComponent={RouteErrorFallback}>
          <Outlet />
        </CatchBoundary>
      ),
    });

    const crashRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/crash",
      component: MaybeCrashPage,
    });

    const projectsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/projects",
      component: () => <h1>Projects</h1>,
    });

    const testRouter = createRouter({
      routeTree: rootRoute.addChildren([crashRoute, projectsRoute]),
      history: createMemoryHistory({ initialEntries: ["/crash"] }),
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <ApiProvider>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={testRouter} />
          </QueryClientProvider>
        </ApiProvider>,
      );

      expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
      expect(screen.getByText("Boom in page")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Go to Projects/i })).toBeInTheDocument();

      shouldThrow = false;
      await user.click(screen.getByRole("button", { name: /Try again/i }));

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "Recovered Page" })).toBeInTheDocument();
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
