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
];
