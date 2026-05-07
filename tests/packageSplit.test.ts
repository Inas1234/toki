import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

async function expectFile(relativePath: string): Promise<void> {
  await expect(access(path.join(repoRoot, relativePath))).resolves.toBeUndefined();
}

describe("workspace package split", () => {
  test("defines the core workspace packages", async () => {
    await expectFile("packages/shared/package.json");
    await expectFile("packages/providers/package.json");
    await expectFile("packages/agent-core/package.json");
    await expectFile("packages/coding-agent/package.json");
  });

  test("wires root workspace dependencies to the extracted packages", async () => {
    const raw = await readFile(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
    };

    expect(pkg.dependencies?.["@toki/shared"]).toBe("workspace:*");
    expect(pkg.dependencies?.["@toki/providers"]).toBe("workspace:*");
    expect(pkg.dependencies?.["@toki/agent-core"]).toBe("workspace:*");
    expect(pkg.dependencies?.["@toki/coding-agent"]).toBe("workspace:*");
  });
});
