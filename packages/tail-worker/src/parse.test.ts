/**
 * Table-driven tests for parseScriptName.
 *
 * The matrix covers (type × team-slug shape × edge case). Add a row
 * before changing the parser — the table is the contract.
 *
 * Critical edge cases captured:
 *   - team slugs with hyphens (e.g. "acme-corp")
 *   - team slug shadowing (longer slug wins; caller orders the list)
 *   - project names with hyphens
 *   - deploy short IDs that look like words (8 hex digits only)
 *   - non-tenant scripts (must return null, not a partial parse)
 */

import { describe, test, expect } from "vitest";
import { parseScriptName, type TeamInfo } from "./parse.js";

const TEAMS_BY_LENGTH: TeamInfo[] = [
  // sorted longest first — same ORDER BY length(slug) DESC the
  // dispatch-worker uses
  { slug: "acme-corp", plan: "pro" },
  { slug: "acme", plan: "pro" },
  { slug: "bob", plan: "free" },
];

describe("parseScriptName", () => {
  describe("recognised tenant scripts", () => {
    const cases: Array<[string, string, ReturnType<typeof parseScriptName>]> = [
      [
        "production: project-team",
        "my-blog-acme",
        { type: "production", team: "acme", project: "my-blog" },
      ],
      [
        "production: single-token project",
        "app-bob",
        { type: "production", team: "bob", project: "app" },
      ],
      [
        "production: team slug with internal hyphens",
        "checkout-acme-corp",
        { type: "production", team: "acme-corp", project: "checkout" },
      ],
      [
        "branch preview",
        "my-blog-git-feature-x-acme",
        {
          type: "branch",
          team: "acme",
          project: "my-blog",
          branch: "feature-x",
        },
      ],
      [
        "branch preview with hyphenated team",
        "checkout-git-main-acme-corp",
        {
          type: "branch",
          team: "acme-corp",
          project: "checkout",
          branch: "main",
        },
      ],
      [
        "deployment preview (8 hex)",
        "my-blog-a1b2c3d4-acme",
        {
          type: "deployment",
          team: "acme",
          project: "my-blog",
          deployId: "a1b2c3d4",
        },
      ],
      [
        "deployment preview with hyphenated project",
        "vite-react-drizzle-13452d26-acme",
        {
          type: "deployment",
          team: "acme",
          project: "vite-react-drizzle",
          deployId: "13452d26",
        },
      ],
    ];

    for (const [name, scriptName, expected] of cases) {
      test(name, () => {
        expect(parseScriptName(scriptName, TEAMS_BY_LENGTH)).toEqual(expected);
      });
    }
  });

  describe("rejected — must return null (drop event)", () => {
    const cases: Array<[string, string]> = [
      ["dispatch-worker itself", "creek-dispatch"],
      ["control-plane", "creek-control-plane"],
      ["realtime-worker", "creek-realtime"],
      ["script with no matching team suffix", "my-blog-someone-else"],
      ["empty string", ""],
      ["only the team suffix", "-acme"],
    ];

    for (const [name, scriptName] of cases) {
      test(name, () => {
        expect(parseScriptName(scriptName, TEAMS_BY_LENGTH)).toBeNull();
      });
    }
  });

  describe("team slug ordering matters when one slug is a suffix of another", () => {
    // The genuinely ambiguous case: script "foo-bar-baz" could be
    // (project="foo-bar", team="baz") OR (project="foo", team="bar-baz").
    // The first team in iteration order whose suffix matches wins, so
    // caller MUST sort longest-first to prefer more-specific teams.
    test("longest-first: 'bar-baz' wins, attributes to (foo, bar-baz)", () => {
      const teamsCorrectOrder: TeamInfo[] = [
        { slug: "bar-baz", plan: "pro" },
        { slug: "baz", plan: "pro" },
      ];
      expect(parseScriptName("foo-bar-baz", teamsCorrectOrder)).toEqual({
        type: "production",
        team: "bar-baz",
        project: "foo",
      });
    });

    test("shortest-first (wrong order): 'baz' wins, misattributes to (foo-bar, baz)", () => {
      const teamsWrongOrder: TeamInfo[] = [
        { slug: "baz", plan: "pro" },
        { slug: "bar-baz", plan: "pro" },
      ];
      expect(parseScriptName("foo-bar-baz", teamsWrongOrder)).toEqual({
        type: "production",
        team: "baz",
        project: "foo-bar",
      });
    });
  });

  describe("deploy ID discrimination", () => {
    test("8-hex segment treated as deployId", () => {
      expect(parseScriptName("app-deadbeef-acme", TEAMS_BY_LENGTH)).toEqual({
        type: "deployment",
        team: "acme",
        project: "app",
        deployId: "deadbeef",
      });
    });

    test("7-hex segment treated as part of project (not enough digits)", () => {
      expect(parseScriptName("app-abc1234-acme", TEAMS_BY_LENGTH)).toEqual({
        type: "production",
        team: "acme",
        project: "app-abc1234",
      });
    });

    test("8-char segment with non-hex char NOT a deployId", () => {
      // "g" is hex-illegal — falls through to production
      expect(parseScriptName("app-deadbeeg-acme", TEAMS_BY_LENGTH)).toEqual({
        type: "production",
        team: "acme",
        project: "app-deadbeeg",
      });
    });
  });
});
