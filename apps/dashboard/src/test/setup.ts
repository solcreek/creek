import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, afterAll } from "vitest";
import { server } from "./mocks/server.js";

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (typeof window !== "undefined") {
  window.scrollTo = () => {};
}

// jsdom has no Web Animations API; Base UI's ScrollArea (used by the coss
// Dialog and Sidebar) calls getAnimations() when it settles.
if (typeof Element !== "undefined" && typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Start MSW before test modules evaluate so singletons (like better-auth's
// createAuthClient) bind to MSW's patched fetch at import time.
server.listen({ onUnhandledRequest: "bypass" });

// Reset handlers between tests
afterEach(() => {
  cleanup();
  server.resetHandlers();
});

// Clean up after all tests
afterAll(async () => {
  // better-auth keeps the session in a nanostores atom, which runs its cleanup
  // STORE_UNMOUNT_DELAY (1000ms) after the last component using it unmounts.
  // That cleanup reads `window`. If the file ends first, jsdom is torn down and
  // the timer throws "window is not defined" as an unhandled error, failing the
  // run although every test passed. Let it run while jsdom still exists.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  server.close();
});
