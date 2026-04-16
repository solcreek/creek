import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/resources")({
  component: () => <Outlet />,
  beforeLoad: ({ location }) => {
    if (location.pathname === "/resources" || location.pathname === "/resources/") {
      throw redirect({ to: "/resources/database" });
    }
  },
});
