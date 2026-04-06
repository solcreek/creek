import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { authClient } from "@/lib/auth";
import { Button } from "@solcreek/ui/components/button";
import { Plus, Trash2, Copy } from "lucide-react";

export const Route = createFileRoute("/_authenticated/api-keys")({
  component: ApiKeysPage,
});

function ApiKeysPage() {
  const queryClient = useQueryClient();
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => authClient.apiKey.list(),
  });

  const createKey = useMutation({
    mutationFn: async (name: string) => {
      const result = await authClient.apiKey.create({ name });
      return result;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      setCreatedKey((result.data as any)?.key ?? null);
      setNewKeyName("");
    },
  });

  const deleteKey = useMutation({
    mutationFn: (keyId: string) => authClient.apiKey.delete({ keyId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const keys = ((data?.data as any)?.apiKeys as any[]) ?? [];

  return (
    <div className="p-6">
      <h1 className="mb-6 text-xl font-semibold">API Keys</h1>

      <p className="mb-4 text-sm text-muted-foreground">
        Use API keys to authenticate the Creek CLI and CI/CD pipelines.
      </p>

      {/* Create new key */}
      <div className="mb-6 flex gap-2">
        <input
          type="text"
          placeholder="Key name (e.g. my-laptop)"
          value={newKeyName}
          onChange={(e) => setNewKeyName(e.target.value)}
          className="w-64 rounded-lg border border-input bg-background px-3 py-1.5 text-sm outline-none focus:border-ring"
        />
        <Button
          size="sm"
          onClick={() => createKey.mutate(newKeyName || "Unnamed")}
          disabled={createKey.isPending}
        >
          <Plus className="size-4" data-icon="inline-start" />
          Create Key
        </Button>
      </div>

      {/* Show newly created key */}
      {createdKey && (
        <div className="mb-6 rounded-lg border border-accent/30 bg-accent/5 p-4">
          <p className="mb-2 text-sm font-medium">
            Key created. Copy it now — you won't see it again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-code-bg px-3 py-1.5 text-sm font-mono">
              {createdKey}
            </code>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => navigator.clipboard.writeText(createdKey)}
            >
              <Copy className="size-4" />
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Use with: <code>creek login --token {createdKey}</code>
          </p>
        </div>
      )}

      {/* List existing keys */}
      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : !keys.length ? (
        <p className="text-muted-foreground">No API keys yet.</p>
      ) : (
        <div className="space-y-1">
          {keys.map((k: any) => (
            <div
              key={k.id}
              className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
            >
              <div>
                <p className="text-sm font-medium">{k.name ?? "Unnamed"}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {k.start ?? "creek_****"}
                </p>
              </div>
              <button
                onClick={() => deleteKey.mutate(k.id)}
                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
