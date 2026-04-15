import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { authClient, useActiveOrganization } from "@/lib/auth";
import { Button } from "@solcreek/ui/components/button";
import { Input } from "@solcreek/ui/components/input";
import { ResourcesPanel } from "./-components/ResourcesPanel";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div className="p-6">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>

      <div className="space-y-10">
        <div className="max-w-lg space-y-8">
          <TeamSettings />
          <MembersList />
        </div>
        <div className="max-w-3xl">
          <ResourcesPanel />
        </div>
      </div>
    </div>
  );
}

function TeamSettings() {
  const { data: activeOrg } = useActiveOrganization();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (activeOrg) {
      setName(activeOrg.name);
      setSlug(activeOrg.slug);
    }
  }, [activeOrg?.id]);

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
      <div className="space-y-4 rounded-lg border border-border p-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Team Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Team"
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Team URL</label>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-team"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => updateOrg.mutate()}
            disabled={updateOrg.isPending}
          >
            {updateOrg.isPending ? "Saving..." : "Save"}
          </Button>
          {saved && <span className="text-sm text-green-400">Saved</span>}
        </div>
      </div>
    </section>
  );
}

function MembersList() {
  const { data: activeOrg } = useActiveOrganization();

  // Better Auth listMembers returns { members: [...] }
  const [members, setMembers] = useState<any[]>([]);

  useEffect(() => {
    if (!activeOrg?.id) return;
    authClient.organization.listMembers({ query: { organizationId: activeOrg.id } }).then((res: any) => {
      setMembers(res.data?.members ?? []);
    });
  }, [activeOrg?.id]);

  return (
    <section>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Members
      </h2>
      <div className="rounded-lg border border-border">
        {members.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No members found.</p>
        ) : (
          <div className="divide-y divide-border">
            {members.map((m: any) => (
              <div key={m.id} className="flex items-center justify-between p-3">
                <div>
                  <p className="text-sm font-medium">{m.user?.name ?? m.userId}</p>
                  <p className="text-xs text-muted-foreground">{m.user?.email}</p>
                </div>
                <span className="rounded bg-secondary px-2 py-0.5 text-xs capitalize">
                  {m.role}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
