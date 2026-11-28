import { http, HttpResponse } from "msw";

const API_URL = "http://localhost:8787";

// Default handlers — tests can override with server.use()
export const handlers = [
  // Auth: session (authenticated by default)
  http.get(`${API_URL}/api/auth/get-session`, () => {
    return HttpResponse.json({
      user: {
        id: "user-1",
        name: "Test User",
        email: "test@creek.dev",
        emailVerified: false,
        role: "user",
        image: null,
      },
      session: {
        id: "session-1",
        userId: "user-1",
        activeOrganizationId: "org-1",
      },
    });
  }),

  // Auth: organization
  http.get(`${API_URL}/api/auth/organization/get-full-organization`, () => {
    return HttpResponse.json({
      id: "org-1",
      name: "Test Team",
      slug: "test-team",
      plan: "free",
    });
  }),

  // Auth: organization list
  http.get(`${API_URL}/api/auth/organization/list`, () => {
    return HttpResponse.json([
      { id: "org-1", name: "Test Team", slug: "test-team" },
      { id: "org-2", name: "Second Team", slug: "second-team" },
    ]);
  }),

  // Auth: organization members
  http.get(`${API_URL}/api/auth/organization/list-members`, () => {
    return HttpResponse.json({ members: [] });
  }),

  // Auth: API keys
  http.get(`${API_URL}/api/auth/api-key/list`, () => {
    return HttpResponse.json({ apiKeys: [] });
  }),

  // Resources: empty list
  http.get(`${API_URL}/resources`, () => {
    return HttpResponse.json({ resources: [] });
  }),

  // Projects: empty list
  http.get(`${API_URL}/projects`, () => {
    return HttpResponse.json([]);
  }),

  // Deployments: empty list
  http.get(`${API_URL}/projects/:projectId/deployments`, () => {
    return HttpResponse.json([]);
  }),

  // Env vars: empty list
  http.get(`${API_URL}/projects/:projectId/env`, () => {
    return HttpResponse.json([]);
  }),

  // Access protection: off, no custom domains
  http.get(`${API_URL}/projects/:projectId/access`, () => {
    return HttpResponse.json({ protected: false, hostnames: [] });
  }),

  // Cloudflare connection: not connected
  http.get(`${API_URL}/integrations/cloudflare`, () => {
    return HttpResponse.json({ configured: true, connected: false });
  }),
];
