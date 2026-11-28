import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderDashboardApp } from "./render.js";

// On narrow screens the sidebar is a sheet that starts closed, so the header
// trigger is the only way to reach navigation. It was hidden whenever the
// (desktop) sidebar state was "open", which is the default.
describe("dashboard shell on a phone-width screen", () => {
  let original: typeof window.matchMedia;

  beforeEach(() => {
    original = window.matchMedia;
    // Every max-width query matches: the coss sidebar's "max-md" check says mobile.
    window.matchMedia = (query: string) =>
      ({
        matches: query.includes("max-width"),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  });

  afterEach(() => {
    window.matchMedia = original;
  });

  test("shows the sidebar trigger, opens the sheet, and closes it after navigating", async () => {
    const user = userEvent.setup();
    renderDashboardApp("/projects");

    const trigger = await screen.findByRole("button", { name: "Toggle Sidebar" });
    await user.click(trigger);

    const sheet = await screen.findByRole("dialog");
    await user.click(await within(sheet).findByRole("link", { name: /API Keys/i }));

    expect(await screen.findByRole("heading", { name: "API Keys" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("closes the sheet when the current page's link is tapped", async () => {
    const user = userEvent.setup();
    renderDashboardApp("/projects");

    await user.click(await screen.findByRole("button", { name: "Toggle Sidebar" }));
    const sheet = await screen.findByRole("dialog");
    // Same route: the pathname does not change, so only the click can close it.
    await user.click(await within(sheet).findByRole("link", { name: /^Projects$/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
