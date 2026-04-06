"use client";

import { useState, useCallback, useRef } from "react";

export type DeployStatus = "idle" | "building" | "deploying" | "active" | "failed";

export interface DeployState {
  status: DeployStatus;
  buildId: string | null;
  previewUrl: string | null;
  sandboxId: string | null;
  expiresAt: string | null;
  error: string | null;
}

const INITIAL_STATE: DeployState = {
  status: "idle",
  buildId: null,
  previewUrl: null,
  sandboxId: null,
  expiresAt: null,
  error: null,
};

export function useWebDeploy() {
  const [state, setState] = useState<DeployState>(INITIAL_STATE);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const deploy = useCallback(async (
    request: {
      type: "template" | "repo";
      template?: string;
      data?: Record<string, string>;
      repo?: string;
      branch?: string;
      path?: string;
    },
  ) => {
    // Clear previous state
    if (pollRef.current) clearInterval(pollRef.current);
    setState({ ...INITIAL_STATE, status: "building" });

    try {
      const API_BASE = "https://api.creek.dev";

      const res = await fetch(`${API_BASE}/web-deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        const errorMsg = err.error === "rate_limited"
          ? "rate_limited"
          : err.message || err.error || `HTTP ${res.status}`;
        setState({ ...INITIAL_STATE, status: "failed", error: errorMsg });
        return;
      }

      const { buildId, statusUrl } = await res.json();
      setState((s) => ({ ...s, buildId }));

      // Poll for status (statusUrl is relative, prepend API base)
      const fullStatusUrl = `${API_BASE}${statusUrl}`;
      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(fullStatusUrl);
          if (!statusRes.ok) return;

          const data = await statusRes.json();
          setState((s) => ({
            ...s,
            status: data.status,
            previewUrl: data.previewUrl || null,
            sandboxId: data.sandboxId || null,
            expiresAt: data.expiresAt || null,
            error: data.error || null,
          }));

          // Stop polling on terminal states
          if (data.status === "active" || data.status === "failed") {
            if (pollRef.current) clearInterval(pollRef.current);
          }
        } catch {
          // Network error during poll — keep trying
        }
      }, 2500);
    } catch (err) {
      setState({
        ...INITIAL_STATE,
        status: "failed",
        error: err instanceof Error ? err.message : "Network error",
      });
    }
  }, []);

  const reset = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setState(INITIAL_STATE);
  }, []);

  return { ...state, deploy, reset };
}
