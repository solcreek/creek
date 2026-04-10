import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { authClient, useSession, useActiveOrganization } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (!session.data) {
      throw redirect({ to: "/login", search: { redirect: undefined } });
    }
    return { user: session.data.user };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { data: session } = useSession();
  const { data: activeOrg } = useActiveOrganization();
  const autoSelectAttempted = useRef(false);

  // Auto-select first organization (non-blocking, runs once)
  useEffect(() => {
    if (session && !activeOrg && !autoSelectAttempted.current) {
      autoSelectAttempted.current = true;
      authClient.organization.list().then((res) => {
        const orgs = (res.data as any[]) ?? [];
        if (orgs.length > 0) {
          authClient.organization.setActive({ organizationId: orgs[0].id });
        }
      });
    }
  }, [session, activeOrg]);

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
