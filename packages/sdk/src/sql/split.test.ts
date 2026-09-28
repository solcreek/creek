import { describe, test, expect } from "vitest";
import { splitSqlStatements } from "./split.js";

describe("splitSqlStatements", () => {
  test("splits on statement-ending semicolons", () => {
    expect(
      splitSqlStatements("CREATE TABLE a (id INT);\nINSERT INTO a VALUES (1); SELECT 1;"),
    ).toEqual(["CREATE TABLE a (id INT)", "INSERT INTO a VALUES (1)", "SELECT 1"]);
  });

  test("the June starter migration: a ; in a comment is not a boundary (#71)", () => {
    const sql = [
      "-- Migrations are explicit and versioned. `june dev` applies pending ones on",
      "-- startup (safe/additive automatically; a destructive change asks first). Add",
      "-- the next change as db/migrations/0002_*.sql — never edit an applied file.",
      "",
      "create table if not exists users (",
      "  id integer primary key autoincrement,",
      "  name text not null",
      ");",
      "",
      "-- A little seed so the app has something to show on first run.",
      "insert into users (name) values ('Ada'), ('Grace');",
      "",
    ].join("\n");
    expect(splitSqlStatements(sql)).toEqual([
      "create table if not exists users (\n  id integer primary key autoincrement,\n  name text not null\n)",
      "insert into users (name) values ('Ada'), ('Grace')",
    ]);
  });

  test("ignores ; inside comments of both kinds", () => {
    expect(splitSqlStatements("/* a; b;\n c; */ SELECT 1; -- x; y\nSELECT 2;")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  test("ignores ; and comment markers inside string literals, including '' escapes", () => {
    expect(
      splitSqlStatements(
        "INSERT INTO t VALUES ('a; b -- not a comment /* nor this */', 'it''s; fine');",
      ),
    ).toEqual(["INSERT INTO t VALUES ('a; b -- not a comment /* nor this */', 'it''s; fine')"]);
  });

  test("ignores ; inside quoted identifiers", () => {
    expect(splitSqlStatements('SELECT "a;b", `c;d`, [e;f] FROM t; SELECT 2')).toEqual([
      'SELECT "a;b", `c;d`, [e;f] FROM t',
      "SELECT 2",
    ]);
  });

  test("keeps a trigger body whole, including a CASE … END inside it", () => {
    const sql = `CREATE TRIGGER tr AFTER INSERT ON a BEGIN
  UPDATE b SET n = CASE WHEN n IS NULL THEN 1 ELSE n + 1 END;
  INSERT INTO log VALUES ('added; ok');
END;
CREATE TEMP TRIGGER t2 BEFORE DELETE ON a BEGIN SELECT 1; END;
INSERT INTO a VALUES (1);`;
    const parts = splitSqlStatements(sql);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^CREATE TRIGGER tr[\s\S]*INSERT INTO log[\s\S]*END$/);
    expect(parts[1]).toBe("CREATE TEMP TRIGGER t2 BEFORE DELETE ON a BEGIN SELECT 1; END");
    expect(parts[2]).toBe("INSERT INTO a VALUES (1)");
  });

  test("BEGIN TRANSACTION outside a trigger is an ordinary statement", () => {
    expect(splitSqlStatements("BEGIN TRANSACTION;\nINSERT INTO a VALUES (1);\nCOMMIT;")).toEqual([
      "BEGIN TRANSACTION",
      "INSERT INTO a VALUES (1)",
      "COMMIT",
    ]);
  });

  test("drops comment-only and empty fragments, and leading comments", () => {
    expect(
      splitSqlStatements("-- only a comment;\n/* and; this */;\n;;\n  -- lead\nSELECT 1;\n-- tail"),
    ).toEqual(["SELECT 1"]);
    expect(splitSqlStatements("   \n-- nothing here\n")).toEqual([]);
  });

  test("a last statement without ; is kept", () => {
    expect(splitSqlStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("an unterminated string runs to the end instead of splitting", () => {
    expect(splitSqlStatements("INSERT INTO t VALUES ('open; string")).toEqual([
      "INSERT INTO t VALUES ('open; string",
    ]);
  });
});
