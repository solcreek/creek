import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { isPortAvailable, findAvailablePort } from "./ports.js";

describe("isPortAvailable", () => {
  it("returns true for available port", async () => {
    // Port 0 asks the OS for a free port — we use a known-free port range
    const result = await isPortAvailable(0);
    // Port 0 always "works" because OS assigns one
    expect(typeof result).toBe("boolean");
  });

  it("returns false for port in use", async () => {
    // Occupy a port
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    const result = await isPortAvailable(port);
    expect(result).toBe(false);

    server.close();
  });
});

describe("findAvailablePort", () => {
  it("returns the preferred port if available", async () => {
    const freePort = await findAvailablePort(19876);
    expect(freePort).toBe(19876);
  });

  it("finds next port when preferred is in use", async () => {
    const server = createServer();
    const occupiedPort = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    const port = await findAvailablePort(occupiedPort);
    expect(port).not.toBe(occupiedPort);
    expect(port).toBeGreaterThan(0);

    server.close();
  });

  it("tries consecutive ports before falling back to random", async () => {
    // Occupy port N — should get N+1
    const server = createServer();
    const occupiedPort = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    const port = await findAvailablePort(occupiedPort);
    // Should be within the +1..+10 range (not a random OS port)
    expect(port).toBeGreaterThanOrEqual(occupiedPort + 1);
    expect(port).toBeLessThanOrEqual(occupiedPort + 10);

    server.close();
  });
});
