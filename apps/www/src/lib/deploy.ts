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
  /** True when remote-builder served this deploy from its KV bundle cache — build phase skipped. */
  cacheHit: boolean;
}

const INITIAL_STATE: DeployState = {
  status: "idle",
  buildId: null,
  previewUrl: null,
  sandboxId: null,
  expiresAt: null,
  error: null,
  cacheHit: false,
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
      let sandboxStatusUrl: string | null = null;

      pollRef.current = setInterval(async () => {
        try {
          // If we have a sandbox status URL, poll it directly for faster updates
          if (sandboxStatusUrl) {
            const sandboxRes = await fetch(sandboxStatusUrl);
            if (sandboxRes.ok) {
              const sandboxData = await sandboxRes.json();
              if (sandboxData.status === "active" || sandboxData.status === "failed") {
                setState((s) => ({
                  ...s,
                  status: sandboxData.status,
                  error: sandboxData.errorMessage || null,
                }));
                if (pollRef.current) clearInterval(pollRef.current);
                return;
              }
            }
          }

          // Also poll the control-plane status for build phase updates
          const statusRes = await fetch(fullStatusUrl);
          if (!statusRes.ok) return;

          const data = await statusRes.json();

          // Capture sandboxStatusUrl when available
          if (data.sandboxStatusUrl) {
            sandboxStatusUrl = data.sandboxStatusUrl;
          }

          setState((s) => ({
            ...s,
            status: data.status,
            previewUrl: data.previewUrl || s.previewUrl,
            sandboxId: data.sandboxId || s.sandboxId,
            expiresAt: data.expiresAt || s.expiresAt,
            error: data.error || null,
            cacheHit: data.cacheHit ?? s.cacheHit,
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
