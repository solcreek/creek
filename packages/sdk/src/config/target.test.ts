import { detectTarget, validateTargetDrivers, parseConfig, type CreekConfig } from "./index.js";

describe("detectTarget", () => {
  it("returns explicit target when set", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      target = "creekd"
    `);
    expect(detectTarget(config)).toBe("creekd");
  });

  it("returns cf for explicit cf target", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      target = "cf"
    `);
    expect(detectTarget(config)).toBe("cf");
  });

  it("defaults to cf when no v2 sections and no target", () => {
    const config = parseConfig(`
      [project]
      name = "test"
    `);
    expect(detectTarget(config)).toBe("cf");
  });

  it("defaults to cf with v1 boolean resources", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      [resources]
      database = true
    `);
    expect(detectTarget(config)).toBe("cf");
  });

  it("infers creekd from database postgres", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      [database]
      driver = "postgres"
    `);
    expect(detectTarget(config)).toBe("creekd");
  });

  it("infers creekd from database mysql", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      [database]
      driver = "mysql"
    `);
    expect(detectTarget(config)).toBe("creekd");
  });

  it("infers creekd from cache redis", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      [cache]
      driver = "redis"
    `);
    expect(detectTarget(config)).toBe("creekd");
  });

  it("infers cf from all-sqlite v2 config", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      [database]
      driver = "sqlite"
      [cache]
      driver = "sqlite"
      [storage]
      driver = "fs"
    `);
    expect(detectTarget(config)).toBe("cf");
  });

  it("explicit target overrides driver inference", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      target = "cf"
      [database]
      driver = "sqlite"
    `);
    expect(detectTarget(config)).toBe("cf");
  });
});

describe("validateTargetDrivers", () => {
  it("passes for cf with sqlite", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      target = "cf"
      [database]
      driver = "sqlite"
    `);
    expect(() => validateTargetDrivers(config)).not.toThrow();
  });

  it("passes for creekd with postgres", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      target = "creekd"
      [database]
      driver = "postgres"
    `);
    expect(() => validateTargetDrivers(config)).not.toThrow();
  });

  it("throws for cf + postgres", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      target = "cf"
      [database]
      driver = "postgres"
    `);
    expect(() => validateTargetDrivers(config)).toThrow(/Incompatible.*cf.*postgres/);
  });

  it("throws for cf + redis", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      target = "cf"
      [cache]
      driver = "redis"
    `);
    expect(() => validateTargetDrivers(config)).toThrow(/Incompatible.*cf.*redis/);
  });

  it("throws for cf + mysql", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      target = "cf"
      [database]
      driver = "mysql"
    `);
    expect(() => validateTargetDrivers(config)).toThrow(/Incompatible.*cf.*mysql/);
  });

  it("passes when no v2 sections (v1 only)", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      [resources]
      database = true
    `);
    expect(() => validateTargetDrivers(config)).not.toThrow();
  });

  it("passes for creekd with all drivers", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      target = "creekd"
      [database]
      driver = "postgres"
      [cache]
      driver = "redis"
      [storage]
      driver = "s3"
      [email]
      enabled = true
    `);
    expect(() => validateTargetDrivers(config)).not.toThrow();
  });
});

describe("release phase config", () => {
  it("parses release command", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      [release]
      command = "bun run db:migrate"
    `);
    expect(config.release?.command).toBe("bun run db:migrate");
    expect(config.release?.timeout).toBe(60);
  });

  it("parses custom timeout", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      [release]
      command = "npx prisma migrate deploy"
      timeout = 120
    `);
    expect(config.release?.command).toBe("npx prisma migrate deploy");
    expect(config.release?.timeout).toBe(120);
  });

  it("release is optional", () => {
    const config = parseConfig(`
      [project]
      name = "test"
    `);
    expect(config.release).toBeUndefined();
  });

  it("release works with creekd target", () => {
    const config = parseConfig(`
      [project]
      name = "test"
      target = "creekd"
      [database]
      driver = "postgres"
      [release]
      command = "bun run db:migrate"
    `);
    expect(detectTarget(config)).toBe("creekd");
    expect(config.release?.command).toBe("bun run db:migrate");
  });
});
