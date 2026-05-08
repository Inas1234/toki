import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../packages/coding-agent/src/core/system-prompt.js";

describe("buildSystemPrompt", () => {
  test("includes explicit runtime platform and shell guidance", () => {
    const prompt = buildSystemPrompt({
      cwd: "D:\\Programing\\Web\\Toki",
      selectedTools: ["read", "bash", "edit", "write"],
      toolSnippets: {
        read: "Read file contents",
        bash: "Execute shell commands",
        edit: "Apply precise edits",
        write: "Create or overwrite files"
      },
      runtimeEnvironment: {
        platform: "win32",
        shell: "powershell",
        shellDisplayName: "Windows PowerShell"
      }
    });

    expect(prompt).toContain("Runtime environment:");
    expect(prompt).toContain("- OS platform: win32");
    expect(prompt).toContain("- Shell: Windows PowerShell");
    expect(prompt).toContain("Use Windows-compatible shell commands");
    expect(prompt).toContain("Do not assume Unix utilities like ls, cat, grep, or find are available");
  });
});
