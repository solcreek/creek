"use client";

import Script from "next/script";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";

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

export const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(
  function TurnstileWidget({ sitekey, action, onToken, onError, theme = "dark", className }, ref) {
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

    const renderWidget = useCallback(() => {
      if (
        !sitekey ||
        !containerRef.current ||
        widgetIdRef.current !== null ||
        typeof window === "undefined" ||
        !window.turnstile
      ) {
        return;
      }

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
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
    }, [sitekey, action, theme]);

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

    // Handle remounts when api.js is already loaded and Script.onReady has already fired.
    useEffect(() => {
      onTokenRef.current("");
      renderWidget();

      return () => {
        if (widgetIdRef.current !== null) {
          window.turnstile?.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }
      };
    }, [renderWidget]);

    if (!sitekey) return null;

    return (
      <>
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          strategy="afterInteractive"
          onReady={renderWidget}
          onError={() => {
            onTokenRef.current("");
            onErrorRef.current?.();
          }}
        />
        <div ref={containerRef} className={className} />
      </>
    );
  },
);
