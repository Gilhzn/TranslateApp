import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, type HealthBody } from "./route";

const KEY = "ANTHROPIC_API_KEY";
const PROVIDER = "LINGOLOOP_PROVIDER";

describe("GET /api/health", () => {
  let originalKey: string | undefined;
  let originalProvider: string | undefined;

  beforeEach(() => {
    originalKey = process.env[KEY];
    originalProvider = process.env[PROVIDER];
    delete process.env[KEY];
    delete process.env[PROVIDER];
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env[KEY];
    else process.env[KEY] = originalKey;
    if (originalProvider === undefined) delete process.env[PROVIDER];
    else process.env[PROVIDER] = originalProvider;
  });

  async function read(): Promise<HealthBody> {
    const response = GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json()) as HealthBody;
  }

  it("reports offline simulation honestly when no key is configured", async () => {
    const body = await read();
    expect(body.status).toBe("ok");
    expect(body.apiKeyConfigured).toBe(false);
    expect(body.provider.mode).toBe("simulation");
    expect(body.provider.model).toBeNull();
    expect(body.provider.detail).toContain("not translations");
  });

  it("reports the live provider when a key is configured", async () => {
    process.env[KEY] = "sk-ant-secret-value-do-not-leak";
    const body = await read();
    expect(body.apiKeyConfigured).toBe(true);
    expect(body.provider.mode).toBe("live");
    expect(body.provider.ready).toBe(true);
    expect(typeof body.provider.model).toBe("string");
  });

  it("reports degraded when Anthropic is forced without a key", async () => {
    process.env[PROVIDER] = "anthropic";
    const body = await read();
    expect(body.status).toBe("degraded");
    expect(body.provider.ready).toBe(false);
    expect(body.provider.forced).toBe(true);
  });

  it("never leaks the key, a prefix of it, or its length", async () => {
    const secret = "sk-ant-api03-THIS-MUST-NEVER-APPEAR";
    process.env[KEY] = secret;
    const serialised = JSON.stringify(await read());

    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain("sk-ant");
    expect(serialised).not.toContain(secret.slice(0, 8));
    expect(serialised).not.toContain(String(secret.length));
  });

  it("publishes the request limits the UI needs to validate before posting", async () => {
    const body = await read();
    expect(body.limits.maxTargetLocales).toBeGreaterThan(0);
    expect(body.limits.maxSourceTextBytes).toBeGreaterThan(0);
    expect(body.limits.maxRepairAttempts).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });
});
