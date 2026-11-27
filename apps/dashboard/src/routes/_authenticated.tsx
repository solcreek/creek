import {
  CatchBoundary,
  createFileRoute,
  Outlet,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import { authClient } from "@/lib/auth";
import { detectApiMode } from "@/lib/adapter";
import { AppShell } from "@/components/app-shell";
import { FullScreenErrorFallback, RouteErrorFallback } from "@/components/route-error";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    if (detectApiMode() === "creekd") {
      return { user: null };
    }

    try {
      const session = (await Promise.race([
        authClient.getSession(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ])) as Awaited<ReturnType<typeof authClient.getSession>>;
      if (!session?.data?.user) {
        throw redirect({ to: "/login", search: { redirect: undefined } });
      }
      return { user: session.data.user };
    } catch (e) {
      if (e && typeof e === "object" && "to" in e) throw e;
      throw redirect({ to: "/login", search: { redirect: undefined } });
    }
  },
  component: AuthenticatedLayout,
  errorComponent: FullScreenErrorFallback,
});

function AuthenticatedLayout() {
  const location = useLocation();

  return (
    <AppShell>
      <CatchBoundary getResetKey={() => location.pathname} errorComponent={RouteErrorFallback}>
        <Outlet />
      </CatchBoundary>
    </AppShell>
  );
}
