import { describe, expect, it } from "vitest";
import { GitHubRestAdapter, encodeBase64, type FetchLike } from "./adapter";
import { SyncError } from "./errors";
import { jsonResponse } from "./testing";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

/** A fetch stand-in that replays queued responses and records every call. */
function stubFetch(
  responses: Array<Response | Error | (() => Response | Error)>,
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      signal: init.signal ?? undefined,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error(`Unexpected request: ${init.method} ${url}`);
    const resolved = typeof next === "function" ? next() : next;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  };
  return { fetch: fetchImpl, calls };
}

function adapterWith(
  responses: Array<Response | Error | (() => Response | Error)>,
  options: { token?: string; now?: number } = {},
) {
  const stub = stubFetch(responses);
  const adapter = new GitHubRestAdapter({
    token: options.token ?? "ghp_test",
    fetchImpl: stub.fetch,
    now: () => options.now ?? Date.parse("2026-07-30T14:00:00Z"),
  });
  return { adapter, calls: stub.calls };
}

const REPO = { owner: "indiedev", repo: "deck-forge" };

describe("isConfigured", () => {
  it("is false without a token and true with one", () => {
    expect(new GitHubRestAdapter().isConfigured()).toBe(false);
    expect(new GitHubRestAdapter({ token: "   " }).isConfigured()).toBe(false);
    expect(new GitHubRestAdapter({ token: "ghp_x" }).isConfigured()).toBe(true);
  });

  it("refuses to send anything when unconfigured", async () => {
    const stub = stubFetch([]);
    const adapter = new GitHubRestAdapter({ fetchImpl: stub.fetch });
    await expect(
      adapter.createBranch({ ...REPO, baseBranch: "main", branchName: "x" }),
    ).rejects.toMatchObject({ code: "not-configured" });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("createBranch", () => {
  it("reads the base ref and creates the new one", async () => {
    const { adapter, calls } = adapterWith([
      jsonResponse(200, { object: { sha: "basesha" } }),
      jsonResponse(201, { ref: "refs/heads/lingoloop/x", object: { sha: "basesha" } }),
    ]);

    const branch = await adapter.createBranch({
      ...REPO,
      baseBranch: "main",
      branchName: "lingoloop/x",
    });

    expect(branch).toEqual({ name: "lingoloop/x", sha: "basesha", created: true });
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/indiedev/deck-forge/git/ref/heads/main",
    );
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.body).toEqual({ ref: "refs/heads/lingoloop/x", sha: "basesha" });
  });

  it("sends the documented auth and version headers", async () => {
    const { adapter, calls } = adapterWith([
      jsonResponse(200, { object: { sha: "basesha" } }),
      jsonResponse(201, { object: { sha: "newsha" } }),
    ]);
    await adapter.createBranch({ ...REPO, baseBranch: "main", branchName: "b" });
    expect(calls[0]?.headers).toMatchObject({
      Authorization: "Bearer ghp_test",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(calls[0]?.headers["User-Agent"]).toBeTruthy();
  });

  it("keeps slashes in branch names hierarchical but escapes the rest", async () => {
    const { adapter, calls } = adapterWith([
      jsonResponse(200, { object: { sha: "s" } }),
      jsonResponse(201, { object: { sha: "s" } }),
    ]);
    await adapter.createBranch({
      ...REPO,
      baseBranch: "release/2026 Q3",
      branchName: "b",
    });
    expect(calls[0]?.url).toContain("/git/ref/heads/release/2026%20Q3");
  });

  it("reuses a branch that already exists", async () => {
    const { adapter, calls } = adapterWith([
      jsonResponse(200, { object: { sha: "basesha" } }),
      jsonResponse(422, { message: "Reference already exists" }),
      jsonResponse(200, { object: { sha: "existingsha" } }),
    ]);

    const branch = await adapter.createBranch({
      ...REPO,
      baseBranch: "main",
      branchName: "lingoloop/x",
    });
    expect(branch).toEqual({
      name: "lingoloop/x",
      sha: "existingsha",
      created: false,
    });
    expect(calls).toHaveLength(3);
  });

  it("reports a base branch that does not exist as not-found", async () => {
    const { adapter } = adapterWith([jsonResponse(404, { message: "Not Found" })]);
    await expect(
      adapter.createBranch({ ...REPO, baseBranch: "nope", branchName: "b" }),
    ).rejects.toMatchObject({ code: "not-found", status: 404 });
  });

  it("rejects a 2xx that carries no sha", async () => {
    const { adapter } = adapterWith([jsonResponse(200, { object: {} })]);
    await expect(
      adapter.createBranch({ ...REPO, baseBranch: "main", branchName: "b" }),
    ).rejects.toMatchObject({ code: "malformed-response" });
  });
});

describe("putFile", () => {
  const input = {
    ...REPO,
    branch: "lingoloop/x",
    path: "public/locales/de.json",
    contents: '{\n  "menu": {\n    "save": "Speichern"\n  }\n}\n',
    message: "i18n: de",
  };

  it("creates a file that does not exist yet", async () => {
    const { adapter, calls } = adapterWith([
      jsonResponse(404, { message: "Not Found" }),
      jsonResponse(201, {
        content: { sha: "blob1" },
        commit: { sha: "commit1", html_url: "https://github.com/c/1" },
      }),
    ]);

    const commit = await adapter.putFile(input);
    expect(commit).toEqual({
      sha: "commit1",
      contentSha: "blob1",
      url: "https://github.com/c/1",
      changed: true,
    });

    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/indiedev/deck-forge/contents/public/locales/de.json?ref=lingoloop%2Fx",
    );
    const body = calls[1]?.body as Record<string, string>;
    expect(body["sha"]).toBeUndefined();
    expect(body["branch"]).toBe("lingoloop/x");
    expect(decodeBase64(body["content"] ?? "")).toBe(input.contents);
  });

  it("passes the existing blob sha when updating", async () => {
    const { adapter, calls } = adapterWith([
      jsonResponse(200, { sha: "oldblob" }),
      jsonResponse(200, { content: { sha: "newblob" }, commit: { sha: "commit2" } }),
    ]);
    const commit = await adapter.putFile(input);
    expect((calls[1]?.body as Record<string, string>)["sha"]).toBe("oldblob");
    expect(commit.changed).toBe(true);
    expect(commit.url).toBeNull();
  });

  it("reports an unchanged file", async () => {
    const { adapter } = adapterWith([
      jsonResponse(200, { sha: "same" }),
      jsonResponse(200, { content: { sha: "same" }, commit: { sha: "c" } }),
    ]);
    expect((await adapter.putFile(input)).changed).toBe(false);
  });

  it("round-trips non-Latin content through base64", async () => {
    const { adapter, calls } = adapterWith([
      jsonResponse(404, { message: "Not Found" }),
      jsonResponse(201, { content: { sha: "b" }, commit: { sha: "c" } }),
    ]);
    const contents = '{"ja":"保存する","emoji":"🎮","de":"Straße"}';
    await adapter.putFile({ ...input, contents });
    expect(decodeBase64((calls[1]?.body as Record<string, string>)["content"] ?? "")).toBe(
      contents,
    );
  });

  it("surfaces a stale-sha 409 as a conflict", async () => {
    const { adapter } = adapterWith([
      jsonResponse(200, { sha: "old" }),
      jsonResponse(409, { message: "is at 9fa1 but expected 0e1c" }),
    ]);
    await expect(adapter.putFile(input)).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
  });

  it("does not swallow a non-404 failure from the existence probe", async () => {
    const { adapter } = adapterWith([jsonResponse(401, { message: "Bad credentials" })]);
    await expect(adapter.putFile(input)).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("openPullRequest", () => {
  it("posts the plan's title and body", async () => {
    const { adapter, calls } = adapterWith([
      jsonResponse(201, {
        number: 7,
        html_url: "https://github.com/indiedev/deck-forge/pull/7",
        state: "open",
        draft: false,
      }),
    ]);

    const pr = await adapter.openPullRequest({
      ...REPO,
      head: "lingoloop/x",
      base: "main",
      title: "i18n: German",
      body: "## Locales",
    });

    expect(pr).toEqual({
      number: 7,
      url: "https://github.com/indiedev/deck-forge/pull/7",
      state: "open",
      draft: false,
    });
    expect(calls[0]?.body).toEqual({
      title: "i18n: German",
      head: "lingoloop/x",
      base: "main",
      body: "## Locales",
    });
  });

  it("only sends draft when asked", async () => {
    const { adapter, calls } = adapterWith([
      jsonResponse(201, { number: 8, html_url: "u", state: "open", draft: true }),
    ]);
    await adapter.openPullRequest({
      ...REPO,
      head: "h",
      base: "b",
      title: "t",
      body: "b",
      draft: true,
    });
    expect((calls[0]?.body as Record<string, unknown>)["draft"]).toBe(true);
  });

  it("reports field-level 422 detail", async () => {
    const { adapter } = adapterWith([
      jsonResponse(422, {
        message: "Validation Failed",
        documentation_url: "https://docs.github.com/rest/pulls",
        errors: [{ resource: "PullRequest", field: "head", code: "invalid", message: "No commits between main and head" }],
      }),
    ]);
    try {
      await adapter.openPullRequest({ ...REPO, head: "h", base: "main", title: "t", body: "b" });
      expect.unreachable("should have thrown");
    } catch (error) {
      const syncError = error as SyncError;
      expect(syncError.code).toBe("validation-failed");
      expect(syncError.details).toContain("No commits between main and head");
      expect(syncError.documentationUrl).toBe("https://docs.github.com/rest/pulls");
      expect(syncError.userMessage).toContain("No commits");
    }
  });
});

describe("error mapping", () => {
  const cases: Array<[number, string]> = [
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not-found"],
    [409, "conflict"],
    [422, "validation-failed"],
    [500, "server-error"],
    [503, "server-error"],
    [418, "unexpected"],
  ];

  for (const [status, code] of cases) {
    it(`maps ${status} to ${code}`, async () => {
      const { adapter } = adapterWith([jsonResponse(status, { message: "boom" })]);
      await expect(
        adapter.openPullRequest({ ...REPO, head: "h", base: "b", title: "t", body: "b" }),
      ).rejects.toMatchObject({ code, status });
    });
  }

  it("treats a 403 with an exhausted rate limit as rate-limited", async () => {
    const now = Date.parse("2026-07-30T14:00:00Z");
    const reset = Math.floor((now + 90_000) / 1000);
    const { adapter } = adapterWith(
      [
        jsonResponse(
          403,
          { message: "API rate limit exceeded for user" },
          {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset),
            "x-github-request-id": "ABC:123",
          },
        ),
      ],
      { now },
    );

    try {
      await adapter.openPullRequest({ ...REPO, head: "h", base: "b", title: "t", body: "b" });
      expect.unreachable("should have thrown");
    } catch (error) {
      const syncError = error as SyncError;
      expect(syncError.code).toBe("rate-limited");
      expect(syncError.retryable).toBe(true);
      expect(syncError.retryAfterMs).toBe(90_000);
      expect(syncError.rateLimit).toEqual({ remaining: 0, resetAt: reset * 1000 });
      expect(syncError.requestId).toBe("ABC:123");
    }
  });

  it("honours a Retry-After header on 429", async () => {
    const { adapter } = adapterWith([
      jsonResponse(429, { message: "Too many requests" }, { "retry-after": "60" }),
    ]);
    await expect(
      adapter.openPullRequest({ ...REPO, head: "h", base: "b", title: "t", body: "b" }),
    ).rejects.toMatchObject({ code: "rate-limited", retryAfterMs: 60_000 });
  });

  it("keeps a plain 403 as forbidden, not rate-limited", async () => {
    const { adapter } = adapterWith([
      jsonResponse(
        403,
        { message: "Resource not accessible by integration" },
        { "x-ratelimit-remaining": "4321" },
      ),
    ]);
    await expect(
      adapter.openPullRequest({ ...REPO, head: "h", base: "b", title: "t", body: "b" }),
    ).rejects.toMatchObject({ code: "forbidden", retryable: false });
  });

  it("turns a fetch rejection into a network error, not a raw throw", async () => {
    const { adapter } = adapterWith([new TypeError("fetch failed")]);
    try {
      await adapter.openPullRequest({ ...REPO, head: "h", base: "b", title: "t", body: "b" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SyncError);
      expect((error as SyncError).code).toBe("network");
      expect((error as SyncError).cause).toBeInstanceOf(TypeError);
    }
  });

  it("reads an HTML error page without crashing", async () => {
    const { adapter } = adapterWith([
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    ]);
    await expect(
      adapter.openPullRequest({ ...REPO, head: "h", base: "b", title: "t", body: "b" }),
    ).rejects.toMatchObject({ code: "server-error", status: 502 });
  });

  it("rejects a success body that is not JSON", async () => {
    const { adapter } = adapterWith([
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    ]);
    await expect(
      adapter.openPullRequest({ ...REPO, head: "h", base: "b", title: "t", body: "b" }),
    ).rejects.toMatchObject({ code: "malformed-response" });
  });

  it("rejects a success body missing the documented fields", async () => {
    const { adapter } = adapterWith([jsonResponse(201, { state: "open" })]);
    await expect(
      adapter.openPullRequest({ ...REPO, head: "h", base: "b", title: "t", body: "b" }),
    ).rejects.toMatchObject({ code: "malformed-response" });
  });
});

describe("cancellation", () => {
  it("never sends a request for an already-aborted signal", async () => {
    const stub = stubFetch([]);
    const adapter = new GitHubRestAdapter({ token: "t", fetchImpl: stub.fetch });
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.createBranch(
        { ...REPO, baseBranch: "main", branchName: "b" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(stub.calls).toHaveLength(0);
  });

  it("forwards the signal to fetch and maps an abort mid-flight", async () => {
    const controller = new AbortController();
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const stub = stubFetch([
      () => {
        controller.abort();
        return abortError;
      },
    ]);
    const adapter = new GitHubRestAdapter({ token: "t", fetchImpl: stub.fetch });

    await expect(
      adapter.createBranch(
        { ...REPO, baseBranch: "main", branchName: "b" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(stub.calls[0]?.signal).toBe(controller.signal);
  });
});

describe("base URL", () => {
  it("supports GitHub Enterprise and trims trailing slashes", async () => {
    const stub = stubFetch([jsonResponse(200, { object: { sha: "s" } }), jsonResponse(201, { object: { sha: "s" } })]);
    const adapter = new GitHubRestAdapter({
      token: "t",
      baseUrl: "https://git.acme.dev/api/v3/",
      fetchImpl: stub.fetch,
    });
    await adapter.createBranch({ ...REPO, baseBranch: "main", branchName: "b" });
    expect(stub.calls[0]?.url).toBe(
      "https://git.acme.dev/api/v3/repos/indiedev/deck-forge/git/ref/heads/main",
    );
  });
});

describe("encodeBase64", () => {
  it("matches the reference encoder for ASCII, padding and UTF-8", () => {
    const samples = ["", "a", "ab", "abc", "abcd", "Straße", "保存する", "🎮 GG", '{"a":1}\n'];
    for (const sample of samples) {
      expect(encodeBase64(sample)).toBe(
        Buffer.from(sample, "utf8").toString("base64"),
      );
    }
  });
});

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}
