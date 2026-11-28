import { describe, test, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { TurnstileWidget, type TurnstileWidgetHandle } from "./turnstile-widget";

const TURNSTILE_SCRIPT_SELECTOR =
  'script[src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"]';

describe("TurnstileWidget", () => {
  afterEach(() => {
    delete window.turnstile;
    document.querySelectorAll(TURNSTILE_SCRIPT_SELECTOR).forEach((el) => el.remove());
  });

  test("renders nothing when sitekey is empty", () => {
    const onToken = vi.fn();
    const { container } = render(<TurnstileWidget sitekey="" action="login" onToken={onToken} />);
    expect(container.firstChild).toBeNull();
  });

  test("explicitly renders widget, delivers token, re-renders on action toggle, resets, and cleans up", async () => {
    let nextId = 1;
    let capturedCallback: ((token: string) => void) | undefined;

    const renderMock = vi.fn((_el, options) => {
      capturedCallback = options.callback;
      return `widget-${nextId++}`;
    });
    const resetMock = vi.fn();
    const removeMock = vi.fn();

    window.turnstile = {
      render: renderMock,
      reset: resetMock,
      remove: removeMock,
    };

    const onToken = vi.fn();
    const ref = createRef<TurnstileWidgetHandle>();

    const { rerender, unmount } = render(
      <TurnstileWidget ref={ref} sitekey="test-sitekey" action="login" onToken={onToken} />,
    );

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    expect(renderMock).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ sitekey: "test-sitekey", action: "login" }),
    );

    capturedCallback?.("tok-1");
    expect(onToken).toHaveBeenLastCalledWith("tok-1");

    // Imperative reset clears token and calls turnstile.reset with retained widget ID
    ref.current?.reset();
    expect(onToken).toHaveBeenLastCalledWith("");
    expect(resetMock).toHaveBeenCalledWith("widget-1");

    // Switching action (login -> signup) removes the previous widget and renders a fresh one
    rerender(
      <TurnstileWidget ref={ref} sitekey="test-sitekey" action="signup" onToken={onToken} />,
    );

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(2));
    expect(removeMock).toHaveBeenCalledWith("widget-1");
    expect(renderMock).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ sitekey: "test-sitekey", action: "signup" }),
    );

    unmount();
    expect(removeMock).toHaveBeenCalledWith("widget-2");
  });

  test("removes failed script on error so switching action or remounting retries", async () => {
    const onToken = vi.fn();
    const onError = vi.fn();

    const { rerender } = render(
      <TurnstileWidget sitekey="test-sitekey" action="login" onToken={onToken} onError={onError} />,
    );

    const firstScript = document.querySelector<HTMLScriptElement>(TURNSTILE_SCRIPT_SELECTOR);
    expect(firstScript).not.toBeNull();

    firstScript!.dispatchEvent(new Event("error"));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(document.querySelector(TURNSTILE_SCRIPT_SELECTOR)).toBeNull();

    // Switching action retries by injecting a fresh <script> element
    rerender(
      <TurnstileWidget
        sitekey="test-sitekey"
        action="signup"
        onToken={onToken}
        onError={onError}
      />,
    );

    const retryScript = document.querySelector<HTMLScriptElement>(TURNSTILE_SCRIPT_SELECTOR);
    expect(retryScript).not.toBeNull();
    expect(retryScript).not.toBe(firstScript);

    const renderMock = vi.fn(() => "widget-retry");
    window.turnstile = {
      render: renderMock,
      reset: vi.fn(),
      remove: vi.fn(),
    };
    retryScript!.dispatchEvent(new Event("load"));

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
    expect(renderMock).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ sitekey: "test-sitekey", action: "signup" }),
    );
  });

  test("removes script when load fires without window.turnstile so remounting retries", async () => {
    const onToken = vi.fn();
    const onError = vi.fn();

    const { unmount } = render(
      <TurnstileWidget sitekey="test-sitekey" action="login" onToken={onToken} onError={onError} />,
    );

    const firstScript = document.querySelector<HTMLScriptElement>(TURNSTILE_SCRIPT_SELECTOR);
    expect(firstScript).not.toBeNull();

    firstScript!.dispatchEvent(new Event("load"));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(document.querySelector(TURNSTILE_SCRIPT_SELECTOR)).toBeNull();
    unmount();

    render(
      <TurnstileWidget sitekey="test-sitekey" action="login" onToken={onToken} onError={onError} />,
    );

    const retryScript = document.querySelector<HTMLScriptElement>(TURNSTILE_SCRIPT_SELECTOR);
    expect(retryScript).not.toBeNull();
    expect(retryScript).not.toBe(firstScript);

    const renderMock = vi.fn(() => "widget-retry-2");
    window.turnstile = {
      render: renderMock,
      reset: vi.fn(),
      remove: vi.fn(),
    };
    retryScript!.dispatchEvent(new Event("load"));

    await waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1));
  });
});
