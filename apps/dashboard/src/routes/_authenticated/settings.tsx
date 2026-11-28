import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { authClient, useCurrentTeam } from "@/lib/auth";
import { Button } from "@solcreek/ui/components/button";
import { Badge } from "@solcreek/ui/components/badge";
import { Input } from "@solcreek/ui/components/input";
import { Card, CardPanel } from "@solcreek/ui/components/card";
import { useFeatures } from "@/lib/api-context";
import { CloudflarePanel } from "./-components/CloudflarePanel";

// The Cloudflare OAuth callback returns here with ?cloudflare=connected or ?cloudflare_error=<code>.
interface SettingsSearch {
  cloudflare?: string;
  cloudflare_error?: string;
}

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>): SettingsSearch => ({
    cloudflare: typeof search.cloudflare === "string" ? search.cloudflare : undefined,
    cloudflare_error:
      typeof search.cloudflare_error === "string" ? search.cloudflare_error : undefined,
  }),
});

function SettingsPage() {
  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>

      <div className="max-w-lg space-y-8">
        <TeamSettings />
        <MembersList />
        <CloudflareSettings />
      </div>
    </div>
  );
}

function CloudflareSettings() {
  const features = useFeatures();
  // The team the sidebar shows: the active one, else the first. The API falls
  // back the same way, but the panel names its team on every request anyway.
  const { team, isPending } = useCurrentTeam();
  const search = Route.useSearch();
  const navigate = useNavigate();
  if (!features.teams) return null;

  if (!team) {
    return (
      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Cloudflare
        </h2>
        <Card>
          <CardPanel className="text-sm text-muted-foreground">
            {isPending ? "Loading…" : "Select a team in the sidebar to connect Cloudflare."}
          </CardPanel>
        </Card>
      </section>
    );
  }

  return (
    <CloudflarePanel
      key={team.id}
      team={{ id: team.id, slug: team.slug }}
      callback={{
        connected: search.cloudflare === "connected",
        error: search.cloudflare_error,
      }}
      onDismissCallback={() => navigate({ to: "/settings", search: {}, replace: true })}
    />
  );
}

function TeamSettings() {
  const { team } = useCurrentTeam();
  // Keyed on the organisation so the form starts from its values and resets on switch.
  return <TeamForm key={team?.id ?? "none"} activeOrg={team} />;
}

function TeamForm({ activeOrg }: { activeOrg: { id: string; name: string; slug: string } | null }) {
  const [name, setName] = useState(activeOrg?.name ?? "");
  const [slug, setSlug] = useState(activeOrg?.slug ?? "");
  const [saved, setSaved] = useState(false);

  const updateOrg = useMutation({
    mutationFn: async () => {
      await authClient.organization.update({
        organizationId: activeOrg?.id ?? "",
        data: { name, slug },
      });
    },
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <section>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Team
      </h2>
      <Card>
        <CardPanel className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Team Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Team" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Team URL</label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-team" />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => updateOrg.mutate()} disabled={updateOrg.isPending}>
              {updateOrg.isPending ? "Saving..." : "Save"}
            </Button>
            {saved && <span className="text-sm text-success-foreground">Saved</span>}
          </div>
        </CardPanel>
      </Card>
    </section>
  );
}

function MembersList() {
  const { team } = useCurrentTeam();

  // Better Auth listMembers returns { members: [...] }
  const [members, setMembers] = useState<any[] | null>(null);

  useEffect(() => {
    if (!team?.id) return;
    authClient.organization.listMembers({ query: { organizationId: team.id } }).then((res: any) => {
      setMembers(res.data?.members ?? []);
    });
  }, [team?.id]);

  return (
    <section>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Members
      </h2>
      <Card>
        {members === null ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : members.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No members found.</p>
        ) : (
          <div className="divide-y divide-border">
            {members.map((m: any) => (
              <div key={m.id} className="flex items-center justify-between p-3">
                <div>
                  <p className="text-sm font-medium">{m.user?.name ?? m.userId}</p>
                  <p className="text-xs text-muted-foreground">{m.user?.email}</p>
                </div>
                <Badge variant="secondary" className="capitalize">
                  {m.role}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
    </section>
  );
}
