import { describe, test, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { TurnstileWidget, type TurnstileWidgetHandle } from "./turnstile-widget";

describe("TurnstileWidget", () => {
  afterEach(() => {
    delete window.turnstile;
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
});
