#!/usr/bin/env python3
"""Black-box probe of API key scopes against a running control-plane.

Sends raw HTTP (http.client, so paths go out exactly as written: no
normalization of //, ./, ../ or %2F) and compares each response with what
the scope rules require. Prints one JSON line per probe and a summary;
exits 1 if any probe disagrees.

Usage: api-key-probe.py URL KEYS_JSON DB_PATH
  KEYS_JSON: {"read": "<project:read,env:read key>", "envwrite": "...",
              "preview": "<deploy:preview key>", "legacy": "...",
              "project": "<slug>", "otherTeam": "<slug of another team the owner is in>"}
"""
import http.client
import json
import sqlite3
import sys
import urllib.parse

URL, KEYS_FILE, DB = sys.argv[1], sys.argv[2], sys.argv[3]
K = json.load(open(KEYS_FILE))
P = K["project"]
u = urllib.parse.urlparse(URL)


def send(method, path, headers=None, body=None):
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
    hdrs = list((headers or {}).items()) if isinstance(headers, dict) else list(headers or [])
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs.append(("content-type", "application/json"))
    conn.putrequest(method, path, skip_accept_encoding=True)
    for k, v in hdrs:
        conn.putheader(k, v)
    if data is not None:
        conn.putheader("content-length", str(len(data)))
    conn.endheaders(data)
    res = conn.getresponse()
    raw = res.read()
    conn.close()
    try:
        err = json.loads(raw).get("error")
    except Exception:
        err = None
    return res.status, err


def count(table):
    with sqlite3.connect(DB) as db:
        return db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]


results = []


def probe(name, method, path, headers, expect, body=None, unchanged=()):
    """expect: (status, error) | ("not2xx", None) | ("2xx", None)"""
    before = {t: count(t) for t in unchanged}
    status, err = send(method, path, headers, body)
    after = {t: count(t) for t in unchanged}
    kind, want_err = expect
    if kind == "not2xx":
        ok = not (200 <= status < 300)
    elif kind == "2xx":
        ok = 200 <= status < 300
    else:
        ok = status == kind and (want_err is None or err == want_err)
    ok = ok and before == after
    results.append(ok)
    print(json.dumps({"ok": ok, "probe": name, "request": f"{method} {path}",
                      "got": [status, err], "want": list(expect),
                      "rowsUnchanged": before == after if unchanged else None}))


key = lambda k: {"x-api-key": K[k]}

# --- Better Auth endpoints: a key reads its session, nothing else ---------
probe("key reads its session", "GET", "/api/auth/get-session", key("read"), (200, None))
for path in [
    "/api/auth/api-key/create",
    "/api/auth//api-key/create",
    "/api/auth/./api-key/create",
    "/api/auth/get-session/../api-key/create",
    "/api/auth/api-key%2Fcreate",
    "/api/auth/api-key/create/",
    "/api/auth/API-KEY/CREATE",
    "/api//auth/api-key/create",
    "/api/auth/api-key/create?x=/get-session",
]:
    for who in ["read", "legacy"]:
        probe(f"{who} key cannot mint a key via {path}", "POST", path, key(who), ("not2xx", None),
              body={"name": "escalate"}, unchanged=["apikey"])
probe("scoped key cannot list keys", "GET", "/api/auth/api-key/list", key("read"), (403, "api_key_not_allowed"))
probe("scoped key cannot create an org", "POST", "/api/auth/organization/create", key("read"),
      (403, "api_key_not_allowed"), body={"name": "x", "slug": "x-org"}, unchanged=["organization"])
probe("header name casing is the same key", "POST", "/api/auth/api-key/create",
      {"X-API-KEY": K["read"]}, (403, "api_key_not_allowed"), body={"name": "e"}, unchanged=["apikey"])

# --- Scopes on app routes --------------------------------------------------
probe("read key lists projects", "GET", "/projects", key("read"), (200, None))
probe("read key reads env", "GET", f"/projects/{P}/env", key("read"), (200, None))
probe("HEAD is a read", "HEAD", "/projects", key("read"), (200, None))
probe("read key cannot set env", "POST", f"/projects/{P}/env", key("read"), (403, "insufficient_scope"),
      body={"key": "A", "value": "b"}, unchanged=["environment_variable"])
probe("method override header is ignored", "POST", f"/projects/{P}/env",
      {**key("read"), "x-http-method-override": "GET"}, (403, "insufficient_scope"),
      body={"key": "A", "value": "b"}, unchanged=["environment_variable"])
probe("percent-encoded slug is the same route", "POST", f"/projects/%{ord(P[0]):02X}{P[1:]}/env",
      key("read"), (403, "insufficient_scope"), body={"key": "A", "value": "b"},
      unchanged=["environment_variable"])
probe("trailing slash does not reach the endpoint", "POST", f"/projects/{P}/env/", key("read"),
      ("not2xx", None), body={"key": "A", "value": "b"}, unchanged=["environment_variable"])
probe("read key cannot delete the project", "DELETE", f"/projects/{P}", key("read"),
      (403, "insufficient_scope"), unchanged=["project"])
probe("read key cannot run SQL", "POST", "/resources/x/query", key("read"), (403, "insufficient_scope"),
      body={"sql": "SELECT 1"})
probe("env:write key sets env", "POST", f"/projects/{P}/env", key("envwrite"), ("2xx", None),
      body={"key": "PROBE", "value": "1"})
probe("legacy key keeps full access", "POST", f"/projects/{P}/env", key("legacy"), ("2xx", None),
      body={"key": "LEGACY", "value": "1"})

# --- Headers that try to smuggle a second identity --------------------------
# A duplicated header is one value to everything that reads it (Bun keeps the
# last; Workers joins them, which no key matches), so the request runs as at
# most one key. What must never happen is two keys' scopes being combined:
# neither of these keys has env:write, in either order.
for pair in [("read", "preview"), ("preview", "read")]:
    probe(f"two scoped keys {pair} do not combine scopes", "POST", f"/projects/{P}/env",
          [("x-api-key", K[pair[0]]), ("x-api-key", K[pair[1]])], ("not2xx", None),
          body={"key": "DUP", "value": "1"}, unchanged=["environment_variable"])
probe("key in the query string is not a credential", "GET", f"/projects?x-api-key={K['legacy']}", {},
      (401, "unauthorized"))
probe("key as Bearer is not a credential", "GET", "/projects", {"authorization": f"Bearer {K['legacy']}"},
      (401, "unauthorized"))

# --- Team pinning ------------------------------------------------------------
probe("scoped key refuses another team", "GET", "/projects",
      {**key("read"), "x-creek-team": K["otherTeam"]}, (403, "team_mismatch"))
probe("legacy key may pick another team", "GET", "/projects",
      {**key("legacy"), "x-creek-team": K["otherTeam"]}, (200, None))

# --- Deploy scope by branch ---------------------------------------------------
probe("preview key cannot create a production deployment", "POST", f"/projects/{P}/deployments",
      key("preview"), (403, "insufficient_scope"), body={}, unchanged=["deployment"])
probe("preview key cannot name the production branch", "POST", f"/projects/{P}/deployments",
      key("preview"), (403, "insufficient_scope"), body={"branch": "main"}, unchanged=["deployment"])
probe("preview key creates a preview deployment", "POST", f"/projects/{P}/deployments",
      key("preview"), (201, None), body={"branch": "feature"})

failed = results.count(False)
print(json.dumps({"summary": True, "probes": len(results), "failed": failed}))
sys.exit(1 if failed else 0)
