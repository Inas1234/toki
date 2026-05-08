import { Checkpoint, ContextItem, ContextReceipt, Phase, TaskFrame } from "../types.js";

function xml(tag: string, content: string): string {
  return `<${tag}>\n${content.trim()}\n</${tag}>`;
}

function renderTask(task: TaskFrame, phase: Phase, successCriteria: string): string {
  return [
    `objective: ${task.objective}`,
    `intent: ${task.intent}`,
    `phase: ${phase.name}`,
    `risk: ${task.risk}`,
    `needsEdit: ${task.needsEdit}`,
    `needsTests: ${task.needsTests}`,
    `success_criteria: ${successCriteria}`
  ].join("\n");
}

function renderState(checkpoint: Checkpoint): string {
  return [
    `task: ${checkpoint.task}`,
    `phase: ${checkpoint.phase}`,
    `completed: ${checkpoint.completed.join("; ") || "(none)"}`,
    `files_changed: ${checkpoint.filesChanged.join(", ") || "(none)"}`,
    `decisions: ${checkpoint.decisions.join("; ") || "(none)"}`,
    `current_state: ${checkpoint.currentState}`,
    `next_steps: ${checkpoint.nextSteps.join("; ") || "(none)"}`,
    `known_issues: ${checkpoint.knownIssues.join("; ") || "(none)"}`
  ].join("\n");
}

function renderReceipt(receipt: ContextReceipt): string {
  const loaded = receipt.loaded
    .map(
      (item) =>
        `loaded ${item.path ?? item.source} as ${item.representation} (${item.estimatedTokens}t) reason=${item.reason}`
    )
    .join("\n");
  const skipped = receipt.skipped
    .map((item) => `skipped ${item.path} (${item.estimatedTokens}t) reason=${item.reason}`)
    .join("\n");
  const compressed = receipt.compressed
    .map((item) => `compressed ${item.source} ${item.fromTokens}t -> ${item.toTokens}t via ${item.method}`)
    .join("\n");

  return [
    `mode: ${receipt.mode}`,
    `ceiling: ${receipt.ceiling}`,
    `used: ${receipt.usedTokens}`,
    `saved: ${receipt.savedTokens}`,
    `loaded:\n${loaded || "(none)"}`,
    `skipped:\n${skipped || "(none)"}`,
    `compressed:\n${compressed || "(none)"}`
  ].join("\n");
}

function renderSelected(items: ContextItem[]): string {
  return items
    .map((item) => `[${item.representation}] ${item.path ?? item.source}\n${item.content}`)
    .join("\n\n");
}

export interface PromptBuildInput {
  task: TaskFrame;
  phase: Phase;
  checkpoint: Checkpoint;
  receipt: ContextReceipt;
  selectedContext: ContextItem[];
  repoRules: string;
  pinnedContext: string[];
  toolResults: string;
  instructions: string;
  successCriteria: string;
}

export function buildPrompt(input: PromptBuildInput): string {
  const blocks = [
    xml("TASK", renderTask(input.task, input.phase, input.successCriteria)),
    xml("STATE", renderState(input.checkpoint)),
    xml("CONTEXT_RECEIPT", renderReceipt(input.receipt)),
    xml("REPO_RULES", input.repoRules || "(none)"),
    xml("PINNED_CONTEXT", input.pinnedContext.join("\n") || "(none)"),
    xml("SELECTED_CONTEXT", renderSelected(input.selectedContext)),
    xml("TOOL_RESULTS", input.toolResults || "(none)"),
    xml("INSTRUCTIONS", input.instructions)
  ];
  return blocks.join("\n\n");
}
