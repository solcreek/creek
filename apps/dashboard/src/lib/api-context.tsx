import { createContext, useContext, useMemo, type ReactNode } from "react";
import { type ApiMode, detectApiMode } from "./adapter";

interface FeatureFlags {
  auth: boolean;
  teams: boolean;
  deployments: boolean;
  github: boolean;
  resources: boolean;
  analytics: boolean;
  envVars: boolean;
  apiKeys: boolean;
  appStats: boolean;
  volumes: boolean;
  liveTail: boolean;
}

interface ApiContextValue {
  mode: ApiMode;
  features: FeatureFlags;
}

const HOSTED_FEATURES: FeatureFlags = {
  auth: true,
  teams: true,
  deployments: true,
  github: true,
  resources: true,
  analytics: true,
  envVars: true,
  apiKeys: true,
  appStats: false,
  volumes: false,
  liveTail: true,
};

const CREEKD_FEATURES: FeatureFlags = {
  auth: false,
  teams: false,
  deployments: false,
  github: false,
  resources: false,
  analytics: false,
  envVars: false,
  apiKeys: false,
  appStats: true,
  volumes: true,
  liveTail: false,
};

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({ children }: { children: ReactNode }) {
  const value = useMemo<ApiContextValue>(() => {
    const mode = detectApiMode();
    return {
      mode,
      features: mode === "creekd" ? CREEKD_FEATURES : HOSTED_FEATURES,
    };
  }, []);

  return <ApiContext value={value}>{children}</ApiContext>;
}

export function useApiContext(): ApiContextValue {
  const ctx = useContext(ApiContext);
  if (!ctx) {
    throw new Error("useApiContext must be used within <ApiProvider>");
  }
  return ctx;
}

export function useApiMode(): ApiMode {
  return useApiContext().mode;
}

export function useFeatures(): FeatureFlags {
  return useApiContext().features;
}
