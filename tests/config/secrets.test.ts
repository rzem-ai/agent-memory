import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSecret } from "../../src/config/index.js";

describe("resolveSecret", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });

  it("reads a file-backed secret without writing it to stdout or stderr", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-memory-secret-"));
    directories.push(directory);
    const path = join(directory, "token");
    writeFileSync(path, "highly-sensitive-token\n", { mode: 0o600 });
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(resolveSecret({ file: path }, {})).toBe("highly-sensitive-token");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
