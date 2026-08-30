/**
 * The observatory emitter: inert without config, never throws, carries the
 * bearer, announces with a heartbeat, says goodbye once.
 */

import { describe, expect, it } from "vitest";
import { HEARTBEAT_MS, createMesh, inertMesh } from "../../src/observability/mesh.js";
import type { MeshIdentity } from "../../src/observability/mesh.js";

const identity: MeshIdentity = { pid: 4242, startedAt: "2026-08-30T00:00:00.000Z", peers: [] };
const event = { correlationId: "", taskId: "", type: "status" as const, payload: { state: "OK" } };
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A fetch stand-in that records every posted body and header set, in order. */
function recorder() {
  const posts: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
    posts.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
    });
    return Promise.resolve(new Response());
  };
  return { posts, fetchImpl };
}

describe("createMesh", () => {
  it("is the inert singleton without config", () => {
    expect(createMesh(undefined, identity)).toBe(inertMesh);
    expect(() => {
      inertMesh.emit(event);
      inertMesh.announce({ kind: "repl" });
      inertMesh.farewell();
    }).not.toThrow();
  });

  it("stamps id, ts and the configured name, and posts to <url>/events", async () => {
    const { posts, fetchImpl } = recorder();
    const mesh = createMesh({ url: "http://hub/", name: "memory" }, identity, { fetchImpl });
    mesh.emit(event);
    await tick();
    expect(posts[0]?.url).toBe("http://hub/events");
    expect(posts[0]?.body).toMatchObject({ agent: "memory", type: "status", correlationId: "" });
    expect(typeof posts[0]?.body.id).toBe("string");
    expect(typeof posts[0]?.body.ts).toBe("string");
    expect(posts[0]?.headers.authorization).toBeUndefined();
  });

  it("carries the bearer on every post when a token is configured", async () => {
    const { posts, fetchImpl } = recorder();
    const mesh = createMesh({ url: "http://hub", name: "memory", token: "s3cret" }, identity, { fetchImpl, heartbeatMs: 60_000 });
    mesh.emit(event);
    mesh.announce({ kind: "mcp-stdio" });
    mesh.farewell();
    await tick();
    expect(posts).toHaveLength(3);
    for (const post of posts) expect(post.headers.authorization).toBe("Bearer s3cret");
  });

  it("a dead hub and a throwing fetch are both contained", async () => {
    const dead = createMesh({ url: "http://hub", name: "memory" }, identity, { fetchImpl: () => Promise.reject(new Error("down")) });
    const throwing = createMesh({ url: "http://hub", name: "memory" }, identity, {
      fetchImpl: () => {
        throw new Error("boom");
      },
    });
    expect(() => dead.emit(event)).not.toThrow();
    expect(() => throwing.emit(event)).not.toThrow();
    expect(() => throwing.announce({ kind: "repl" })).not.toThrow();
    await tick();
  });

  it("announce emits agent.hello with identity, role and the surface", async () => {
    const { posts, fetchImpl } = recorder();
    const mesh = createMesh({ url: "http://hub", name: "memory", role: "memory · pg" }, identity, { fetchImpl, heartbeatMs: 60_000 });
    mesh.announce({ kind: "mcp-http", url: "http://127.0.0.1:3010/mcp" });
    await tick();
    mesh.farewell();
    expect(posts[0]?.body.type).toBe("agent.hello");
    expect(posts[0]?.body.payload).toEqual({
      name: "memory",
      role: "memory · pg",
      pid: 4242,
      startedAt: "2026-08-30T00:00:00.000Z",
      peers: [],
      surfaces: [{ kind: "mcp-http", url: "http://127.0.0.1:3010/mcp" }],
    });
  });

  it("heartbeats until farewell, which emits agent.bye exactly once", async () => {
    const { posts, fetchImpl } = recorder();
    const mesh = createMesh({ url: "http://hub", name: "memory" }, identity, { fetchImpl, heartbeatMs: 5 });
    mesh.announce({ kind: "mcp-stdio" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    mesh.farewell();
    mesh.farewell();
    await tick();
    const hellos = posts.filter((p) => p.body.type === "agent.hello").length;
    expect(hellos).toBeGreaterThanOrEqual(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts.filter((p) => p.body.type === "agent.hello").length).toBe(hellos);
    const byes = posts.filter((p) => p.body.type === "agent.bye");
    expect(byes).toHaveLength(1);
    expect(byes[0]?.body.payload).toEqual({ name: "memory", reason: "shutdown" });
  });

  it("defaults to a 15 s heartbeat", () => {
    expect(HEARTBEAT_MS).toBe(15_000);
  });
});
