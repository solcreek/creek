import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export type TurnstileWidgetId = string;

export interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action?: string;
      theme?: "auto" | "light" | "dark";
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    },
  ) => TurnstileWidgetId;
  reset: (widgetId?: TurnstileWidgetId) => void;
  remove: (widgetId: TurnstileWidgetId) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export interface TurnstileWidgetHandle {
  reset: () => void;
}

export interface TurnstileWidgetProps {
  sitekey: string;
  action: string;
  onToken: (token: string) => void;
  onError?: () => void;
  theme?: "auto" | "light" | "dark";
  className?: string;
}

let scriptLoadPromise: Promise<TurnstileApi> | null = null;

function loadTurnstileScript(): Promise<TurnstileApi> {
  if (typeof window !== "undefined" && window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  if (scriptLoadPromise) {
    return scriptLoadPromise;
  }

  scriptLoadPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_SRC}"]`,
    );
    const script = existing ?? document.createElement("script");

    const onLoad = () => {
      script.removeEventListener("error", onErr);
      scriptLoadPromise = null;
      if (window.turnstile) {
        resolve(window.turnstile);
      } else {
        script.remove();
        reject(new Error("Turnstile script loaded without window.turnstile"));
      }
    };
    const onErr = () => {
      script.removeEventListener("load", onLoad);
      scriptLoadPromise = null;
      script.remove();
      reject(new Error("Failed to load Cloudflare Turnstile script"));
    };

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onErr, { once: true });

    if (!existing) {
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });

  return scriptLoadPromise;
}

export const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(
  function TurnstileWidget({ sitekey, action, onToken, onError, theme = "auto", className }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetIdRef = useRef<TurnstileWidgetId | null>(null);
    const onTokenRef = useRef(onToken);
    const onErrorRef = useRef(onError);

    useEffect(() => {
      onTokenRef.current = onToken;
    }, [onToken]);

    useEffect(() => {
      onErrorRef.current = onError;
    }, [onError]);

    useImperativeHandle(
      ref,
      () => ({
        reset() {
          onTokenRef.current("");
          if (widgetIdRef.current !== null) {
            window.turnstile?.reset(widgetIdRef.current);
          }
        },
      }),
      [],
    );

    useEffect(() => {
      if (!sitekey) return;
      let cancelled = false;

      onTokenRef.current("");

      loadTurnstileScript()
        .then((turnstile) => {
          if (cancelled || !containerRef.current) return;
          if (widgetIdRef.current !== null) {
            turnstile.remove(widgetIdRef.current);
            widgetIdRef.current = null;
          }
          widgetIdRef.current = turnstile.render(containerRef.current, {
            sitekey,
            action,
            theme,
            callback: (token) => onTokenRef.current(token),
            "expired-callback": () => onTokenRef.current(""),
            "error-callback": () => {
              onTokenRef.current("");
              onErrorRef.current?.();
            },
          });
        })
        .catch(() => {
          if (!cancelled) {
            onTokenRef.current("");
            onErrorRef.current?.();
          }
        });

      return () => {
        cancelled = true;
        if (widgetIdRef.current !== null) {
          window.turnstile?.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }
      };
    }, [sitekey, action, theme]);

    if (!sitekey) return null;

    return <div ref={containerRef} className={className} />;
  },
);
