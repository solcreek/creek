import { describe, test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "./render.js";
import { server } from "./mocks/server.js";

const API_URL = "http://localhost:8787";

// --------------------------------------------------------------------------
// Since TanStack Router pages are coupled to `Route.useParams()` etc,
// we test the API interaction layer directly: render a minimal component
// that uses the same useQuery/useMutation patterns as the real pages.
// This validates the MSW + React Query + render contract.
// --------------------------------------------------------------------------

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useState } from "react";

// --- Projects test component ---

function ProjectList() {
  const { data: projects, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<any[]>("/projects"),
  });

  if (isLoading) return <p>Loading...</p>;
  if (error) return <p>Error: {(error as Error).message}</p>;
  if (!projects?.length) return <p>No projects yet.</p>;

  return (
    <ul>
      {projects.map((p: any) => (
        <li key={p.id}>{p.slug}</li>
      ))}
    </ul>
  );
}

// --- Env vars test component ---

function EnvVarList({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const { data: vars, isLoading } = useQuery({
    queryKey: ["env", projectId],
    queryFn: () => api<any[]>(`/projects/${projectId}/env`),
  });

  const setVar = useMutation({
    mutationFn: (v: { key: string; value: string }) =>
      api(`/projects/${projectId}/env`, {
        method: "POST",
        body: JSON.stringify(v),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["env", projectId] });
      setNewKey("");
      setNewValue("");
    },
  });

  if (isLoading) return <p>Loading...</p>;

  return (
    <div>
      {!vars?.length ? (
        <p>No environment variables set.</p>
      ) : (
        <ul>
          {vars.map((v: any) => (
            <li key={v.key}>{v.key} = {v.value}</li>
          ))}
        </ul>
      )}
      <input
        placeholder="KEY"
        value={newKey}
        onChange={(e) => setNewKey(e.target.value)}
      />
      <input
        placeholder="value"
        value={newValue}
        onChange={(e) => setNewValue(e.target.value)}
      />
      <button onClick={() => setVar.mutate({ key: newKey, value: newValue })}>
        Add
      </button>
    </div>
  );
}

// --- Login form test component ---

function LoginForm() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState("");

  return (
    <div>
      <h1>{mode === "signin" ? "Sign in" : "Create account"}</h1>
      <input placeholder="Email" />
      <input placeholder="Password" type="password" />
      {mode === "signup" && <input placeholder="Name" />}
      {error && <p role="alert">{error}</p>}
      <button>{mode === "signin" ? "Sign in" : "Create account"}</button>
      <button onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
        {mode === "signin" ? "Sign up" : "Back to sign in"}
      </button>
    </div>
  );
}

// ==========================================================================
// Tests
// ==========================================================================

describe("Projects page", () => {
  test("shows empty state when no projects", async () => {
    renderWithProviders(<ProjectList />);

    expect(await screen.findByText("No projects yet.")).toBeInTheDocument();
  });

  test("renders project list from API", async () => {
    server.use(
      http.get(`${API_URL}/projects`, () =>
        HttpResponse.json([
          { id: "1", slug: "my-app", framework: "vite-react", productionDeploymentId: null },
          { id: "2", slug: "my-api", framework: "hono", productionDeploymentId: "d1" },
        ]),
      ),
    );

    renderWithProviders(<ProjectList />);

    expect(await screen.findByText("my-app")).toBeInTheDocument();
    expect(screen.getByText("my-api")).toBeInTheDocument();
  });

  test("shows error when API fails", async () => {
    server.use(
      http.get(`${API_URL}/projects`, () =>
        HttpResponse.json({ error: "server_error", message: "DB down" }, { status: 500 }),
      ),
    );

    renderWithProviders(<ProjectList />);

    expect(await screen.findByText(/Error:/)).toBeInTheDocument();
  });
});

describe("Env vars page", () => {
  test("shows empty state", async () => {
    renderWithProviders(<EnvVarList projectId="proj-1" />);

    expect(await screen.findByText("No environment variables set.")).toBeInTheDocument();
  });

  test("renders env var list", async () => {
    server.use(
      http.get(`${API_URL}/projects/proj-1/env`, () =>
        HttpResponse.json([
          { key: "DATABASE_URL", value: "DATA****" },
          { key: "API_KEY", value: "API_****" },
        ]),
      ),
    );

    renderWithProviders(<EnvVarList projectId="proj-1" />);

    expect(await screen.findByText(/DATABASE_URL/)).toBeInTheDocument();
    expect(screen.getByText(/API_KEY/)).toBeInTheDocument();
  });

  test("adds a new env var", async () => {
    const user = userEvent.setup();
    let posted = false;

    server.use(
      http.post(`${API_URL}/projects/proj-1/env`, async ({ request }) => {
        const body = await request.json() as any;
        posted = true;
        expect(body.key).toBe("NEW_VAR");
        expect(body.value).toBe("secret123");
        return HttpResponse.json({ ok: true, key: "NEW_VAR" }, { status: 201 });
      }),
    );

    renderWithProviders(<EnvVarList projectId="proj-1" />);

    await screen.findByText("No environment variables set.");

    await user.type(screen.getByPlaceholderText("KEY"), "NEW_VAR");
    await user.type(screen.getByPlaceholderText("value"), "secret123");
    await user.click(screen.getByText("Add"));

    await waitFor(() => expect(posted).toBe(true));
  });
});

describe("Login form", () => {
  test("renders sign in mode by default", () => {
    renderWithProviders(<LoginForm />);

    expect(screen.getByRole("heading")).toHaveTextContent("Sign in");
    expect(screen.getByPlaceholderText("Email")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Password")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Name")).not.toBeInTheDocument();
  });

  test("switches to sign up mode", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginForm />);

    await user.click(screen.getByText("Sign up"));

    expect(screen.getByRole("heading")).toHaveTextContent("Create account");
    expect(screen.getByPlaceholderText("Name")).toBeInTheDocument();
  });

  test("switches back to sign in", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginForm />);

    await user.click(screen.getByText("Sign up"));
    await user.click(screen.getByText("Back to sign in"));

    expect(screen.getByRole("heading")).toHaveTextContent("Sign in");
    expect(screen.queryByPlaceholderText("Name")).not.toBeInTheDocument();
  });
});
