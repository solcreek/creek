import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { authClient } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (!session.data) {
      throw redirect({ to: "/login", search: { redirect: undefined } });
    }

    // Auto-select first organization if none is active
    if (!session.data.session.activeOrganizationId) {
      const orgs = await authClient.organization.list();
      const orgList = (orgs.data as any[]) ?? [];
      if (orgList.length > 0) {
        await authClient.organization.setActive({ organizationId: orgList[0].id });
      }
    }

    return { user: session.data.user };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
