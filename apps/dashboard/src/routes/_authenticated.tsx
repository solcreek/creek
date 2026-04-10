import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { authClient } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    try {
      const session = await Promise.race([
        authClient.getSession(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]) as Awaited<ReturnType<typeof authClient.getSession>>;
      if (!session?.data?.user) {
        throw redirect({ to: "/login", search: { redirect: undefined } });
      }
      return { user: session.data.user };
    } catch (e) {
      if (e && typeof e === "object" && "to" in e) throw e; // re-throw redirect
      throw redirect({ to: "/login", search: { redirect: undefined } });
    }
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
