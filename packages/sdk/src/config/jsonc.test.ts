import { describe, test, expect } from "vitest";
import { stripJsoncComments } from "./jsonc.js";

describe("stripJsoncComments", () => {
  test("strips line comments", () => {
    const input = `{
  "name": "test" // this is a comment
}`;
    const result = JSON.parse(stripJsoncComments(input));
    expect(result.name).toBe("test");
  });

  test("strips block comments", () => {
    const input = `{
  /* this is a block comment */
  "name": "test"
}`;
    const result = JSON.parse(stripJsoncComments(input));
    expect(result.name).toBe("test");
  });

  test("strips multi-line block comments", () => {
    const input = `{
  /*
   * multi-line
   * block comment
   */
  "name": "test"
}`;
    const result = JSON.parse(stripJsoncComments(input));
    expect(result.name).toBe("test");
  });

  test("preserves // inside strings", () => {
    const input = `{
  "url": "https://example.com"
}`;
    const result = JSON.parse(stripJsoncComments(input));
    expect(result.url).toBe("https://example.com");
  });

  test("preserves /* */ inside strings", () => {
    const input = `{
  "pattern": "/* not a comment */"
}`;
    const result = JSON.parse(stripJsoncComments(input));
    expect(result.pattern).toBe("/* not a comment */");
  });

  test("strips trailing commas before }", () => {
    const input = `{
  "a": 1,
  "b": 2,
}`;
    const result = JSON.parse(stripJsoncComments(input));
    expect(result).toEqual({ a: 1, b: 2 });
  });

  test("strips trailing commas before ]", () => {
    const input = `{
  "items": [1, 2, 3,]
}`;
    const result = JSON.parse(stripJsoncComments(input));
    expect(result.items).toEqual([1, 2, 3]);
  });

  test("handles escaped quotes in strings", () => {
    const input = `{
  "msg": "say \\"hello\\"" // comment
}`;
    const result = JSON.parse(stripJsoncComments(input));
    expect(result.msg).toBe('say "hello"');
  });

  test("handles mixed comments and trailing commas", () => {
    const input = `{
  // Project config
  "name": "my-app", // the name
  "version": 1, /* trailing comma + block comment */
}`;
    const result = JSON.parse(stripJsoncComments(input));
    expect(result).toEqual({ name: "my-app", version: 1 });
  });

  test("returns valid JSON for empty object", () => {
    expect(JSON.parse(stripJsoncComments("{}"))).toEqual({});
  });

  test("handles comment-only input", () => {
    const result = stripJsoncComments("// just a comment");
    expect(result.trim()).toBe("");
  });
});
