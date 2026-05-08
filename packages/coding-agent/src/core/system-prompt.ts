import type { ToolName } from "@toki/agent-core";

export interface RuntimeEnvironment {
  platform: string;
  shell?: string;
  shellDisplayName?: string;
}

export interface BuildSystemPromptOptions {
  customPrompt?: string;
  selectedTools?: ToolName[];
  toolSnippets?: Partial<Record<ToolName, string>>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd: string;
  runtimeEnvironment?: RuntimeEnvironment;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const { customPrompt, selectedTools, toolSnippets, promptGuidelines, appendSystemPrompt, cwd, runtimeEnvironment } = options;
  const resolvedCwd = cwd.replace(/\\/g, "/");
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
  const runtimeSection = runtimeEnvironment
    ? [
        "Runtime environment:",
        `- OS platform: ${runtimeEnvironment.platform}`,
        `- Shell: ${runtimeEnvironment.shellDisplayName ?? runtimeEnvironment.shell ?? "unknown"}`
      ].join("\n")
    : "";

  if (customPrompt) {
    const runtimeSuffix = runtimeSection.length > 0 ? `\n${runtimeSection}` : "";
    return `${customPrompt}${appendSection}${runtimeSuffix}\nCurrent date: ${date}\nCurrent working directory: ${resolvedCwd}`;
  }

  const tools = selectedTools ?? ["read", "bash", "edit", "write"];
  const visibleTools = tools.filter((name) => toolSnippets?.[name]);
  const toolsList =
    visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets?.[name]}`).join("\n") : "(none)";

  const guidelinesList: string[] = [];
  const seen = new Set<string>();
  const addGuideline = (guideline: string) => {
    const normalized = guideline.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    guidelinesList.push(normalized);
  };

  if (tools.includes("bash") && (tools.includes("grep") || tools.includes("find") || tools.includes("ls"))) {
    addGuideline("Prefer grep/find/ls tools over bash for file exploration.");
  } else if (tools.includes("bash")) {
    addGuideline("Use bash for terminal actions and shell inspection.");
  }

  if (runtimeEnvironment?.platform === "win32") {
    addGuideline("Use Windows-compatible shell commands.");
    addGuideline("Do not assume Unix utilities like ls, cat, grep, or find are available unless the prompt explicitly says they are installed.");
  } else if (runtimeEnvironment) {
    addGuideline(`Use commands compatible with the detected shell (${runtimeEnvironment.shellDisplayName ?? runtimeEnvironment.shell ?? "unknown shell"}).`);
  }

  for (const guideline of promptGuidelines ?? []) {
    addGuideline(guideline);
  }

  addGuideline("Be concise in your responses.");
  addGuideline("Show file paths clearly when working with files.");

  let prompt = `You are Toki, a deterministic coding assistant operating inside a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

Guidelines:
${guidelinesList.map((guideline) => `- ${guideline}`).join("\n")}`;

  if (appendSection) {
    prompt += appendSection;
  }

  if (runtimeSection.length > 0) {
    prompt += `\n\n${runtimeSection}`;
  }

  prompt += `\nCurrent date: ${date}`;
  prompt += `\nCurrent working directory: ${resolvedCwd}`;
  return prompt;
}
