/**
 * Creek Build Server — runs inside a CF Container on port 8080.
 *
 * GET  /        → health check
 * POST /build   → clone + build + return bundle
 */

import { createServer } from "node:http";
import { buildAndBundle, type BuildRequest } from "./build-pipeline.js";

const PORT = 8080;

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ready", node: process.version }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;

  try {
    const request: BuildRequest = JSON.parse(body);
    if (!request.repoUrl) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "repoUrl is required" }));
      return;
    }

    const result = await buildAndBundle(request);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "internal",
      message: err instanceof Error ? err.message : String(err),
    }));
  }
});

server.listen(PORT, () => {
  console.log(`Creek build server :${PORT}`);
});
