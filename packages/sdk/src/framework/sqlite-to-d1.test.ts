import { describe, test, expect } from "vitest";
import { sqliteDumpToD1, splitStatements } from "./sqlite-to-d1.js";

describe("sqliteDumpToD1", () => {
  test("drops PRAGMA statements", () => {
    const input = `PRAGMA foreign_keys=OFF;
CREATE TABLE t (id integer);`;
    const out = sqliteDumpToD1(input);
    expect(out).not.toMatch(/PRAGMA/i);
    expect(out).toMatch(/CREATE TABLE t/);
  });

  test("drops BEGIN TRANSACTION and COMMIT", () => {
    const input = `BEGIN TRANSACTION;
INSERT INTO t VALUES (1);
COMMIT;`;
    const out = sqliteDumpToD1(input);
    expect(out).not.toMatch(/BEGIN TRANSACTION/i);
    expect(out).not.toMatch(/COMMIT/i);
    expect(out).toMatch(/INSERT INTO t/);
  });

  test("preserves regular DDL and DML", () => {
    const input = `CREATE TABLE t (id integer);
INSERT INTO t VALUES (1);
INSERT INTO t VALUES (2);`;
    const out = sqliteDumpToD1(input);
    expect(out).toMatch(/CREATE TABLE t/);
    expect(out.match(/INSERT INTO t/g)?.length).toBe(2);
  });

  test("unwraps INSERT INTO sqlite_schema virtual-table bootstrap", () => {
    // A compact version of what .dump emits for FTS5 virtual tables.
    const input = `INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','fts_posts','fts_posts',0,'CREATE VIRTUAL TABLE "fts_posts" USING fts5(
title, content,
content=''posts'',
tokenize=''porter''
)');`;
    const out = sqliteDumpToD1(input);
    expect(out).not.toMatch(/INSERT INTO sqlite_schema/);
    expect(out).toMatch(/CREATE VIRTUAL TABLE "fts_posts" USING fts5/);
    // Doubled '' should be unescaped back to single '.
    expect(out).toMatch(/content='posts'/);
    expect(out).toMatch(/tokenize='porter'/);
  });

  test("drops FTS5 shadow table CREATE statements", () => {
    const input = `CREATE TABLE IF NOT EXISTS 'fts_posts_data'(id INTEGER PRIMARY KEY, block BLOB);
CREATE TABLE IF NOT EXISTS 'fts_posts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS 'fts_posts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE IF NOT EXISTS 'fts_posts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
CREATE TABLE t (id integer);`;
    const out = sqliteDumpToD1(input);
    expect(out).not.toMatch(/fts_posts_data/);
    expect(out).not.toMatch(/fts_posts_idx/);
    expect(out).not.toMatch(/fts_posts_docsize/);
    expect(out).not.toMatch(/fts_posts_config/);
    expect(out).toMatch(/CREATE TABLE t/);
  });

  test("drops FTS5 shadow table INSERT statements (unquoted names)", () => {
    const input = `INSERT INTO fts_posts_data VALUES(1,X'abc');
INSERT INTO fts_posts_idx VALUES(1,X'',2);
INSERT INTO fts_posts_docsize VALUES(1,X'def');
INSERT INTO fts_posts_config VALUES('version',4);
INSERT INTO posts VALUES(1,'hello');`;
    const out = sqliteDumpToD1(input);
    expect(out).not.toMatch(/fts_posts_data/);
    expect(out).not.toMatch(/fts_posts_idx/);
    expect(out).not.toMatch(/fts_posts_docsize/);
    expect(out).not.toMatch(/fts_posts_config/);
    expect(out).toMatch(/INSERT INTO posts/);
  });

  test("end-to-end: a realistic dump survives transform", () => {
    const input = `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE posts (id integer primary key, title text);
INSERT INTO posts VALUES(1,'Welcome');
INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','fts_posts','fts_posts',0,'CREATE VIRTUAL TABLE "fts_posts" USING fts5(title)');
CREATE TABLE IF NOT EXISTS 'fts_posts_data'(id INTEGER PRIMARY KEY, block BLOB);
INSERT INTO fts_posts_data VALUES(1,X'abc');
COMMIT;`;
    const out = sqliteDumpToD1(input);
    // Kept:
    expect(out).toMatch(/CREATE TABLE posts/);
    expect(out).toMatch(/INSERT INTO posts VALUES\(1,'Welcome'\)/);
    expect(out).toMatch(/CREATE VIRTUAL TABLE "fts_posts" USING fts5\(title\)/);
    // Dropped:
    expect(out).not.toMatch(/PRAGMA/i);
    expect(out).not.toMatch(/BEGIN TRANSACTION/i);
    expect(out).not.toMatch(/COMMIT/i);
    expect(out).not.toMatch(/sqlite_schema/);
    expect(out).not.toMatch(/fts_posts_data/);
  });

  test("joins output with ;\\n so split on ; is safe for D1 batch", () => {
    const input = `CREATE TABLE a (id integer);
CREATE TABLE b (id integer);`;
    const out = sqliteDumpToD1(input);
    const parts = out.split(";\n").filter(Boolean);
    expect(parts).toHaveLength(2);
  });
});

describe("splitStatements", () => {
  test("splits on semicolon + newline", () => {
    expect(splitStatements("a;\nb;\nc")).toEqual(["a", "b", "c"]);
  });

  test("preserves multi-line CREATE VIRTUAL TABLE content", () => {
    const input = `CREATE VIRTUAL TABLE x USING fts5(
id UNINDEXED,
title,
tokenize='porter'
);
INSERT INTO x VALUES(1,'hi');`;
    const parts = splitStatements(input);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/CREATE VIRTUAL TABLE x/);
    expect(parts[0]).toMatch(/tokenize='porter'/);
  });

  test("drops single-line and block comments", () => {
    const input = `-- header comment;
/* block comment;
multi-line */;
CREATE TABLE t (id integer);`;
    const parts = splitStatements(input);
    expect(parts).toEqual(["CREATE TABLE t (id integer)"]);
  });
});
