import { buildTaskFrame } from "./task/taskFrame.js";
import path from "node:path";
import { exec as execCallback } from "node:child_process";
import { stat } from "node:fs/promises";
import { evaluateEditLoopRound, isMutationCall, parseToolCallsFromText, ToolCall } from "@toki/agent-core";
import { ModelProvider, ProviderListItem, ProviderRegistry } from "@toki/providers";
import { ChatChunk, ContextItem, ProviderChatMessage, TaskFrame, fileExists, listFilesRecursive, readTextFile, writeTextFile } from "@toki/shared";
import { ContextGraph } from "./graph/contextGraph.js";
import { ContextBroker } from "./broker/contextBroker.js";
import { ContextLedger } from "./ledger/ledger.js";
import { Compressor } from "./compressor/compressor.js";
import { buildPrompt } from "./orchestrator/promptBuilder.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { loadConfig, modeToCeiling, ResolvedConfig, saveGlobalConfig } from "./config.js";

interface EngineInit {
  cwd: string;
}

export interface TurnExecution {
  response: string;
  contextLine: string;
}

interface ToolExecutionOutput {
  display: string;
  report: string;
  mutationSuccessCount: number;
  errors: string[];
}

interface ModelRoundOutput {
  content: string;
}

const MINIMAX_MIN_TIMEOUT_MS = 120000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const MAX_COMMAND_BUFFER_BYTES = 4 * 1024 * 1024;
const COMMAND_PREVIEW_MAX_CHARS = 4000;
const COMMAND_REPORT_MAX_CHARS = 12000;
const COMMAND_PREVIEW_MAX_LINES = 40;

function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "0t";
  }
  if (tokens < 1000) {
    return `${Math.round(tokens)}t`;
  }
  return `${(tokens / 1000).toFixed(1)}k`;
}

const SYSTEM_PROMPT = [
  "You are Toki, a deterministic coding assistant.",
  "Only rely on provided context and explicitly state uncertainty when context is missing.",
  "Prefer concise, actionable output with minimal filler.",
  "Never output chain-of-thought, internal reasoning, or <think> tags."
].join(" ");

const TOOL_INSTRUCTIONS = [
  "You may use tools to inspect and edit files when needed.",
  "When you need actions, respond ONLY with <tool_calls>...</tool_calls> where content is strict JSON.",
  "Never include <think>...</think> or any hidden reasoning text.",
  "Never show raw tool protocol such as <tool_calls>, [TOOL_CALL], or object literals to the user.",
  "Environment: Windows PowerShell. Do not assume bash utilities like cat, ls, head, tail, or find are available.",
  "When the user asks about recent changes, README updates, changelog work, or explicitly says to check with git, inspect the repo first with run_command such as git status --short, git diff --stat, or git log --oneline -10 before drafting an answer.",
  "For edit tasks, avoid long natural-language search queries. Prefer reading likely files directly, then edit.",
  "If search_files returns 0 for a multi-word phrase, retry with 1-3 concrete identifiers/keywords or use run_command with rg for broader codebase search.",
  "If replace_in_file fails, re-read the file and retry with an exact snippet or use write_file with full updated file content.",
  "Prefer the compact pi-style tools: read, edit, and write.",
  "Allowed tools:",
  '- {"tool":"read","path":"relative/or/absolute","offset":1,"limit":120}',
  '- {"tool":"list_files","path":"relative/or/absolute/dir","query":"optional filename filter","max_results":50}',
  '- {"tool":"search_files","path":"relative/or/absolute/dir","query":"text to find","max_results":20}',
  '- {"tool":"edit","path":"relative/or/absolute","edits":[{"oldText":"exact old text","newText":"replacement text"}]}',
  '- {"tool":"write","path":"relative/or/absolute","content":"full file content"}',
  '- {"tool":"append_file","path":"relative/or/absolute","content":"text to append"}',
  '- {"tool":"replace_in_file","path":"relative/or/absolute","find":"old text","replace":"new text"}',
  '- {"tool":"run_command","command":"git status","cwd":"optional/dir","timeout_ms":30000}',
  "Use edit for targeted replacements, write for new files or full rewrites, and read with offset/limit for large files.",
  "Use run_command for terminal actions such as builds, tests, git inspection, and other shell commands.",
  "You may return either one JSON object or a JSON array of objects.",
  "Do not wrap tool JSON in markdown fences.",
  "When no more edits are required, return the final user-facing answer as plain text."
].join(" ");

function isMutationTool(call: ToolCall): boolean {
  return isMutationCall(call);
}

function shouldTrackDiscoveredPath(call: ToolCall): boolean {
  return call.tool === "read_file" || isMutationTool(call);
}

function filterMutationCalls(calls: ToolCall[]): ToolCall[] {
  return calls.filter(isMutationTool);
}

function filterEditRecoveryCalls(calls: ToolCall[]): ToolCall[] {
  return calls.filter((call) => call.tool === "read_file" || isMutationTool(call));
}

function filterExplorationCallsForEditRecovery(calls: ToolCall[]): ToolCall[] {
  return calls.filter((call) => call.tool === "read_file" || isMutationTool(call));
}

interface SearchFallbackCandidate {
  path: string;
  lineNumber: number;
  line: string;
  score: number;
}

const SEARCH_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "onto",
  "over",
  "under"
]);

export class TokiEngine {
  private config!: ResolvedConfig;
  private graph!: ContextGraph;
  private broker!: ContextBroker;
  private ledger: ContextLedger;
  private compressor: Compressor;
  private orchestrator: Orchestrator;
  private providers!: ProviderRegistry;
  private providerId = "nim";
  private modelId = "llama-3.1-nemotron-ultra";
  private turn = 0;
  private history: ProviderChatMessage[];
  private lastBudgetUsed = 0;
  private lastBudgetCeiling = 0;

  public constructor() {
    this.ledger = new ContextLedger();
    this.compressor = new Compressor();
    this.orchestrator = new Orchestrator();
    this.history = [];
  }

  public async initialize(input: EngineInit): Promise<void> {
    this.config = await loadConfig(input.cwd);
    this.providerId = this.config.global.defaultProvider;
    this.modelId = this.config.global.defaultModel;
    this.providers = new ProviderRegistry(this.config.global);
    this.graph = new ContextGraph(input.cwd, this.config.repo, this.config.paths.repoIndexDir);
    this.broker = new ContextBroker(this.config.global.mode);
    this.lastBudgetCeiling = modeToCeiling(this.broker.getMode(), this.config.global);
    await this.graph.initialize();
  }

  public getHeaderInfo(): { repo: string; provider: string; model: string; mode: string } {
    return {
      repo: path.basename(this.config.paths.repoDir),
      provider: this.providerId,
      model: this.modelId,
      mode: this.broker.getMode()
    };
  }

  public getLedger(): ContextLedger {
    return this.ledger;
  }

  public getBroker(): ContextBroker {
    return this.broker;
  }

  public getCurrentModel(): string {
    return this.modelId;
  }

  public async setModel(modelId: string): Promise<void> {
    const available = await this.listModels();
    if (!available.some((item) => item.id === modelId)) {
      throw new Error(`Model not available: ${modelId}`);
    }
    this.modelId = modelId;
    this.config.global.defaultModel = modelId;
    await saveGlobalConfig(this.config.global, this.config.paths.globalConfigPath);
  }

  public async listModels() {
    return this.providers.get(this.providerId).listModels();
  }

  public getCurrentProvider(): string {
    return this.providerId;
  }

  public listProviders(): ProviderListItem[] {
    return this.providers.listProviders();
  }

  public getProviderRequirements(providerId: string): Array<{ key: string; label: string; masked?: boolean }> {
    return this.providers.getDefinition(providerId)?.requiredCredentials ?? [];
  }

  public providerNeedsCredentials(providerId: string): boolean {
    return !this.providers.isConfigured(providerId);
  }

  public async switchProvider(providerId: string): Promise<void> {
    const definition = this.providers.getDefinition(providerId);
    if (!definition) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    this.providerId = providerId;
    this.config.global.defaultProvider = providerId;
    if (this.providers.isConfigured(providerId)) {
      await this.ensureModelCompatibleWithCurrentProvider();
    }
    await saveGlobalConfig(this.config.global, this.config.paths.globalConfigPath);
  }

  public async setProviderCredential(providerId: string, fieldKey: string, value: string): Promise<void> {
    if (providerId === "nim" && fieldKey === "apiKey") {
      this.config.global.providerApiKeys.nim = value.trim();
      this.providers = new ProviderRegistry(this.config.global);
      if (this.providerId === providerId) {
        await this.ensureModelCompatibleWithCurrentProvider();
      }
      await saveGlobalConfig(this.config.global, this.config.paths.globalConfigPath);
      return;
    }
    if (providerId === "openrouter" && fieldKey === "apiKey") {
      this.config.global.providerApiKeys.openrouter = value.trim();
      this.providers = new ProviderRegistry(this.config.global);
      if (this.providerId === providerId) {
        await this.ensureModelCompatibleWithCurrentProvider();
      }
      await saveGlobalConfig(this.config.global, this.config.paths.globalConfigPath);
      return;
    }
    if (providerId === "minimax" && fieldKey === "apiKey") {
      this.config.global.providerApiKeys.minimax = value.trim();
      this.providers = new ProviderRegistry(this.config.global);
      if (this.providerId === providerId) {
        await this.ensureModelCompatibleWithCurrentProvider();
      }
      await saveGlobalConfig(this.config.global, this.config.paths.globalConfigPath);
      return;
    }
    throw new Error(`Unsupported provider credential ${providerId}.${fieldKey}`);
  }

  public clearConversation(): void {
    this.history = [];
    this.ledger.clear();
  }

  public getBudgetSummary(): { mode: "auto" | "tiny" | "normal" | "deep"; used: number; ceiling: number } {
    return {
      mode: this.broker.getMode(),
      used: this.lastBudgetUsed,
      ceiling: this.lastBudgetCeiling
    };
  }

  public async runTurn(userInput: string, onChunk: (value: string) => void): Promise<TurnExecution> {
    this.turn += 1;
    const task = buildTaskFrame(userInput);
    const phase = this.orchestrator.currentPhase();
    const selection = await this.broker.selectContext(this.turn, task, this.graph, this.config.global);
    this.ledger.record(selection.receipt);
    this.lastBudgetUsed = selection.receipt.usedTokens;
    this.lastBudgetCeiling = selection.receipt.ceiling;

    const repoRules =
      (await fileExists(this.config.paths.repoRulesPath)) === true
        ? await readTextFile(this.config.paths.repoRulesPath)
        : "";
    const compressedHistory = this.compressor.compressHistory(this.history, 1400);

    const provider = this.providers.get(this.providerId);
    let response = "";
    let toolResults = "(none)";
    let executedAnyTools = false;
    let forcedToolRetries = 0;
    let successfulMutations = 0;
    const toolErrors: string[] = [];
    const discoveredPaths = new Set<string>();
    let editExplorationOnlyRounds = 0;

    const maxToolRounds = task.needsEdit
      ? Math.max(this.config.global.runtime.maxToolRounds, 10)
      : this.config.global.runtime.maxToolRounds;
    const maxEditRetries = task.needsEdit
      ? Math.max(this.config.global.runtime.editToolCallRetries, 5)
      : this.config.global.runtime.editToolCallRetries;

    for (let round = 0; round < maxToolRounds; round += 1) {
      const editEnforcement = task.needsEdit
        ? "This is an edit task. Before any prose answer, you MUST emit executable tool_calls JSON and apply required file changes."
        : "";
      const editRecoveryInstructions =
        task.needsEdit && successfulMutations === 0 && toolResults !== "(none)"
          ? "No file mutation has succeeded yet. Your next response must move toward a concrete edit. Do not stop at search/list loops. Prefer read_file on the most likely target, then replace_in_file or write_file."
          : "";
      const prompt = buildPrompt({
        task,
        phase,
        checkpoint: this.orchestrator.getCheckpoint(),
        receipt: selection.receipt,
        selectedContext: selection.items,
        repoRules,
        pinnedContext: this.broker.getPinned(),
        toolResults,
        instructions:
          "Answer the task using only available context. If missing context, request exact files/commands needed. " +
          editEnforcement +
          " " +
          editRecoveryInstructions +
          " " +
          TOOL_INSTRUCTIONS,
        successCriteria: "Return the most useful next response for this turn."
      });

      const messages: ProviderChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "system",
          content:
            compressedHistory.content.length > 0
              ? `Conversation history snapshot:\n${compressedHistory.content}`
              : "(no history)"
        },
        { role: "user", content: prompt }
      ];

      let result: ModelRoundOutput;
      try {
        result = await this.streamRoundWithTimeout(provider, messages, onChunk);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onChunk(`\n* MODEL RETRY Fallback to non-stream after stream error: ${message}\n`);
        const fallbackText = await this.chatOnceWithTimeout(provider, messages);
        result = { content: fallbackText };
      }
      const candidate = this.stripReasoningArtifacts(result.content);
      const calls = this.extractToolCalls(candidate);
      const recoveredCalls =
        calls.length === 0 && !task.needsEdit ? await this.repairToolCalls(provider, candidate) : [];
      const recoveryCalls =
        calls.length === 0 && task.needsEdit && successfulMutations === 0
          ? await this.recoverEditToolCalls(provider, task.raw, toolResults)
          : [];
      const effectiveCalls = calls.length > 0 ? calls : recoveryCalls.length > 0 ? recoveryCalls : recoveredCalls;

      if (effectiveCalls.length === 0) {
        if (task.needsEdit && successfulMutations === 0 && forcedToolRetries < maxEditRetries) {
          forcedToolRetries += 1;
          const lastError = toolErrors.length > 0 ? toolErrors[toolErrors.length - 1] : null;
          const warning = lastError
            ? `No valid edit tool calls after failure (retry ${forcedToolRetries}). Last error: ${lastError}. Retry by reading target file and applying exact replace or write_file.`
            : `Model returned no valid tool calls on edit task (retry ${forcedToolRetries}).`;
          toolResults = `${toolResults === "(none)" ? "" : `${toolResults}\n`}${warning}`.trim();
          onChunk(`* TOOLING(.)\n  L INFO ${warning}\n`);
          continue;
        }
        if (task.needsEdit && successfulMutations === 0) {
          onChunk("* TOOLING(.)\n  L ERROR No successful file mutation was produced for an edit task.\n");
          break;
        }
        response = this.sanitizeUserFacingText(candidate);
        break;
      }

      if (calls.length === 0 && recoveredCalls.length > 0) {
        onChunk("* TOOLING(.)\n  L INFO Recovered valid tool JSON from model output\n");
      }
      if (calls.length === 0 && recoveryCalls.length > 0) {
        onChunk("* TOOLING(.)\n  L INFO Generated recovery tool calls from failed edit transcript\n");
      }

      executedAnyTools = true;
      for (const call of effectiveCalls) {
        if (shouldTrackDiscoveredPath(call) && call.path && call.path.trim().length > 0) {
          discoveredPaths.add(call.path);
        }
      }
      const execution = await this.executeToolCalls(effectiveCalls);
      successfulMutations += execution.mutationSuccessCount;
      toolErrors.push(...execution.errors);
      onChunk(`${execution.display}\n`);
      toolResults = `${toolResults === "(none)" ? "" : `${toolResults}\n`}[round ${round + 1}]\n${execution.report}`.trim();
      if (task.needsEdit && successfulMutations === 0 && execution.mutationSuccessCount === 0) {
        const mutationIntentSeen = effectiveCalls.some(isMutationTool);
        const repairHint =
          execution.errors.length > 0
            ? "Repair hint: previous edit call failed. Read the exact target file and retry with exact find text, or use write_file with full content."
            : mutationIntentSeen
              ? "Repair hint: a mutation was attempted but did not succeed. Retry with exact file text or escalate to write_file."
              : "Repair hint: no file changes yet. Continue with concrete edit calls (write_file/replace_in_file), not only search/read calls.";
        toolResults = `${toolResults}\n${repairHint}`;
      }
      if (task.needsEdit && successfulMutations === 0) {
        const loopState = evaluateEditLoopRound({
          calls: effectiveCalls,
          mutationSuccessCount: execution.mutationSuccessCount,
          previousExplorationOnlyRounds: editExplorationOnlyRounds
        });
        editExplorationOnlyRounds = loopState.explorationOnlyRounds;
        if (loopState.shouldEscalateRecovery) {
          toolResults = `${toolResults}\nEscalation: repeated search/list rounds without file progress. Force direct read/mutation recovery now.`;
          onChunk("* TOOLING(.)\n  L INFO Escalating from repeated exploration-only rounds to forced edit recovery\n");
          this.orchestrator.noteDecision(`Escalated edit recovery after ${editExplorationOnlyRounds} exploration-only round(s)`);
          break;
        }
      }
      this.orchestrator.noteDecision(`Executed ${effectiveCalls.length} tool call(s) in round ${round + 1}`);
    }

    if (task.needsEdit && successfulMutations === 0) {
      const recovery = await this.attemptForcedMutationRecovery(provider, task, selection.items, discoveredPaths, toolResults, onChunk);
      toolResults = recovery.toolResults;
      successfulMutations += recovery.mutationSuccessCount;
      if (recovery.mutationSuccessCount > 0) {
        executedAnyTools = true;
      }
      toolErrors.push(...recovery.errors);
    }

    if (response.length === 0) {
      if (task.needsEdit && successfulMutations === 0) {
        response = await this.summarizeEditFailure(provider, task.raw, toolResults, toolErrors);
      } else if (executedAnyTools) {
        response = await this.synthesizeFinalResponseFromTools(provider, task.raw, toolResults);
      } else {
        response =
          this.inferDirectAnswerFromContext(userInput, selection.items) ??
          "I could not produce a final response after tool execution rounds.";
      }
    }

    if (response.length > 0) {
      onChunk(this.sanitizeUserFacingText(response));
    }

    this.history.push({ role: "user", content: userInput });
    this.history.push({ role: "assistant", content: response });
    this.orchestrator.markCompleted(`turn ${this.turn} responded`);
    this.orchestrator.advance(task);

    const contextLine = `context: ${selection.receipt.mode} / ${formatTokenCount(selection.receipt.usedTokens)} used / saved ~${formatTokenCount(
      selection.receipt.savedTokens
    )}`;

    return {
      response,
      contextLine
    };
  }

  private async ensureModelCompatibleWithCurrentProvider(): Promise<void> {
    if (!this.providers.isConfigured(this.providerId)) {
      return;
    }
    try {
      const available = await this.providers.get(this.providerId).listModels();
      if (available.length === 0) {
        return;
      }
      if (!available.some((item) => item.id === this.modelId)) {
        this.modelId = available[0]!.id;
        this.config.global.defaultModel = this.modelId;
      }
    } catch {
      // Keep current model if the provider cannot list models.
    }
  }

  private extractToolCalls(text: string): ToolCall[] {
    return parseToolCallsFromText(this.stripReasoningArtifacts(text));
  }

  private stripReasoningArtifacts(text: string): string {
    if (text.length === 0) {
      return text;
    }
    return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  }

  private sanitizeUserFacingText(text: string): string {
    if (text.length === 0) {
      return text;
    }
    return this.stripReasoningArtifacts(text)
      .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, "")
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
      .replace(/\[tool_calls?\][\s\S]*?\[\/tool_calls?\]/gi, "")
      .replace(/^\s*\{tool:\s*".*$/gim, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private async streamRoundWithTimeout(
    provider: ModelProvider,
    messages: ProviderChatMessage[],
    onChunk: (value: string) => void
  ): Promise<ModelRoundOutput> {
    const timeoutMs = this.getEffectiveModelTimeoutMs();
    const retries = this.config.global.runtime.modelRoundRetries;
    let lastError: unknown = new Error("Model stream failed.");

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.streamOnceWithTimeout(provider, messages, onChunk, timeoutMs);
      } catch (error) {
        lastError = error;
        const canRetry = this.isRetryableModelError(error);
        if (!canRetry || attempt >= retries) {
          break;
        }
        const delayMs = this.getRetryDelayMs(attempt);
        const message = error instanceof Error ? error.message : String(error);
        onChunk(`\n* MODEL RETRY ${attempt + 1}/${retries} after error: ${message}\n`);
        await this.sleep(delayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async chatOnceWithTimeout(provider: ModelProvider, messages: ProviderChatMessage[]): Promise<string> {
    const timeoutMs = this.getEffectiveModelTimeoutMs();
    const retries = this.config.global.runtime.modelRoundRetries;
    let lastError: unknown = new Error("Model chat failed.");

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const chatPromise = provider.chat(messages, {
          model: this.modelId,
          temperature: 0
        });
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Model request timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        const result = await Promise.race([chatPromise, timeoutPromise]);
        return result.text;
      } catch (error) {
        lastError = error;
        const canRetry = this.isRetryableModelError(error);
        if (!canRetry || attempt >= retries) {
          break;
        }
        await this.sleep(this.getRetryDelayMs(attempt));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async streamOnceWithTimeout(
    provider: ModelProvider,
    messages: ProviderChatMessage[],
    onChunk: (value: string) => void,
    timeoutMs: number
  ): Promise<ModelRoundOutput> {
    const streamPromise = (async () => {
      let content = "";
      let reasoningBuffer = "";
      let lastReasoningEmit = Date.now();

      for await (const chunk of provider.streamChat(messages, {
        model: this.modelId,
        temperature: 0.2,
        stream: true
      })) {
        if (chunk.done) {
          continue;
        }
        if (chunk.channel === "reasoning") {
          reasoningBuffer += chunk.text;
          const shouldFlush = reasoningBuffer.length >= 80 || /\n|[.!?]\s$/.test(reasoningBuffer);
          const now = Date.now();
          if (shouldFlush || now - lastReasoningEmit > 500) {
            const trimmed = reasoningBuffer.trim();
            if (trimmed.length > 0) {
              onChunk(`\n~ ${trimmed}\n`);
            }
            reasoningBuffer = "";
            lastReasoningEmit = now;
          }
          continue;
        }
        content += chunk.text;
      }

      const trailing = reasoningBuffer.trim();
      if (trailing.length > 0) {
        onChunk(`\n~ ${trailing}\n`);
      }

      return { content };
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Model request timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    return Promise.race([streamPromise, timeoutPromise]);
  }

  private getEffectiveModelTimeoutMs(): number {
    const configured = this.config.global.runtime.modelRoundTimeoutMs;
    if (this.providerId === "minimax" && configured < MINIMAX_MIN_TIMEOUT_MS) {
      return MINIMAX_MIN_TIMEOUT_MS;
    }
    return configured;
  }

  private isRetryableModelError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (message.includes("timed out")) {
      return true;
    }
    if (message.includes("fetch failed")) {
      return true;
    }
    if (message.includes("429")) {
      return true;
    }
    if (message.includes("rate limit")) {
      return true;
    }
    if (message.includes("502") || message.includes("503") || message.includes("504")) {
      return true;
    }
    return false;
  }

  private getRetryDelayMs(attempt: number): number {
    const base = this.config.global.runtime.modelRoundRetryBackoffMs;
    const backoff = base * Math.max(1, 2 ** attempt);
    const jitter = Math.floor(Math.random() * 300);
    return backoff + jitter;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async attemptForcedMutationRecovery(
    provider: ModelProvider,
    task: TaskFrame,
    selectedContext: ContextItem[],
    discoveredPaths: Set<string>,
    toolResults: string,
    onChunk: (value: string) => void
  ): Promise<{ toolResults: string; mutationSuccessCount: number; errors: string[] }> {
    let nextToolResults = toolResults;
    const errors: string[] = [];

    const forcedCalls = await this.recoverMutationToolCalls(provider, task.raw, nextToolResults);
    if (forcedCalls.length > 0) {
      onChunk("* TOOLING(.)\n  L INFO Forced mutation recovery generated edit/write tool calls\n");
      const execution = await this.executeToolCalls(forcedCalls);
      onChunk(`${execution.display}\n`);
      return {
        toolResults: `${nextToolResults === "(none)" ? "" : `${nextToolResults}\n`}[forced mutation]\n${execution.report}`.trim(),
        mutationSuccessCount: execution.mutationSuccessCount,
        errors: errors.concat(execution.errors)
      };
    }

    const readCalls = await this.buildForcedRecoveryReadCalls(task, selectedContext, discoveredPaths, nextToolResults);
    if (readCalls.length === 0) {
      return {
        toolResults: nextToolResults,
        mutationSuccessCount: 0,
        errors
      };
    }

    onChunk("* TOOLING(.)\n  L INFO Recovery is reading likely edit targets before a forced mutation attempt\n");
    const readExecution = await this.executeToolCalls(readCalls);
    onChunk(`${readExecution.display}\n`);
    nextToolResults = `${nextToolResults === "(none)" ? "" : `${nextToolResults}\n`}[forced read]\n${readExecution.report}`.trim();
    errors.push(...readExecution.errors);

    const secondForcedCalls = await this.recoverMutationToolCalls(provider, task.raw, nextToolResults);
    if (secondForcedCalls.length === 0) {
      return {
        toolResults: nextToolResults,
        mutationSuccessCount: 0,
        errors
      };
    }

    onChunk("* TOOLING(.)\n  L INFO Forced mutation recovery generated edit/write tool calls\n");
    const execution = await this.executeToolCalls(secondForcedCalls);
    onChunk(`${execution.display}\n`);
    return {
      toolResults: `${nextToolResults === "(none)" ? "" : `${nextToolResults}\n`}[forced mutation]\n${execution.report}`.trim(),
      mutationSuccessCount: execution.mutationSuccessCount,
      errors: errors.concat(execution.errors)
    };
  }

  private async buildForcedRecoveryReadCalls(
    task: TaskFrame,
    selectedContext: ContextItem[],
    discoveredPaths: Set<string>,
    toolResults: string
  ): Promise<ToolCall[]> {
    const alreadyRead = new Set(
      [...toolResults.matchAll(/(?:^|\n)read_file\s+([^\n]+?)\s+lines\s+\d+-\d+/g)].map((match) => match[1]?.trim() ?? "")
    );
    const prioritizedGroups: string[][] = [
      [...discoveredPaths].filter((value) => value.trim().length > 0),
      task.entities.paths.filter((value) => value.trim().length > 0),
      selectedContext.map((item) => item.path).filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    ];

    const calls: ToolCall[] = [];
    const seenCandidates = new Set<string>();
    for (const group of prioritizedGroups) {
      for (const candidate of group) {
        if (seenCandidates.has(candidate) || alreadyRead.has(candidate)) {
          continue;
        }
        seenCandidates.add(candidate);
        try {
          const absPath = this.resolveWorkspacePath(candidate);
          if (!(await fileExists(absPath))) {
            continue;
          }
          const fileStat = await stat(absPath);
          if (!fileStat.isFile()) {
            continue;
          }
          calls.push({
            tool: "read_file",
            path: candidate,
            start_line: 1,
            end_line: 250
          });
        } catch {
          continue;
        }
        if (calls.length >= 2) {
          return calls;
        }
      }
      if (calls.length > 0) {
        return calls;
      }
    }

    return calls;
  }

  private async repairToolCalls(provider: ModelProvider, rawOutput: string): Promise<ToolCall[]> {
    const repairMessages: ProviderChatMessage[] = [
      {
        role: "system",
        content:
          "Convert assistant text into executable tool calls. Return ONLY valid JSON (object or array). No prose, no markdown."
      },
      {
        role: "user",
        content: [
          "Allowed tools:",
          "read, list_files, search_files, edit, write, append_file, replace_in_file, run_command.",
          "If file creation is requested, emit write_file with full content.",
          "If you cannot infer valid arguments, return [] exactly."
        ].join("\n")
      },
      {
        role: "user",
        content: `Model output to convert:\n${this.stripReasoningArtifacts(rawOutput)}`
      }
    ];

    try {
      const repaired = await this.chatOnceWithTimeout(provider, repairMessages);
      return this.extractToolCalls(this.stripReasoningArtifacts(repaired));
    } catch {
      return [];
    }
  }

  private async recoverEditToolCalls(
    provider: ModelProvider,
    userTask: string,
    toolResults: string
  ): Promise<ToolCall[]> {
    const recoveryMessages: ProviderChatMessage[] = [
      {
        role: "system",
        content:
          "You are repairing a failed coding-agent edit loop. Return ONLY valid JSON tool calls. No prose, no markdown."
      },
      {
        role: "user",
        content: [
          "Allowed tools:",
          "read, list_files, search_files, edit, write, append_file, replace_in_file.",
          "Goal: recover from failed edit attempts and produce the next best tool call batch.",
          "Rules:",
          "- Prefer read on the most likely target file, then edit or write.",
          "- Avoid broad search_files/list_files loops unless you truly do not know the file.",
          "- Do not emit run_command during edit recovery. Use file tools only.",
          "- If search_files returned 0 for a multi-word phrase, break it into concrete identifiers/keywords.",
          "- If a previous edit failed, use the file/error previews to choose exact text.",
          "- If exact replacement remains uncertain, emit write or write_file with full corrected file content.",
          "- Return [] only if there is truly no plausible next tool call."
        ].join("\n")
      },
      {
        role: "user",
        content: [`Original task: ${userTask}`, "", "Tool execution report:", toolResults].join("\n")
      }
    ];

    try {
      const recovered = await this.chatOnceWithTimeout(provider, recoveryMessages);
      const sanitized = this.stripReasoningArtifacts(recovered);
      const directCalls = filterExplorationCallsForEditRecovery(this.extractToolCalls(sanitized));
      if (directCalls.length > 0) {
        return directCalls;
      }
      const repairedCalls = await this.repairToolCalls(provider, sanitized);
      return filterExplorationCallsForEditRecovery(repairedCalls);
    } catch {
      return [];
    }
  }

  private async recoverMutationToolCalls(
    provider: ModelProvider,
    userTask: string,
    toolResults: string
  ): Promise<ToolCall[]> {
    const recoveryMessages: ProviderChatMessage[] = [
      {
        role: "system",
        content:
          "You are repairing a stalled coding-agent edit turn. Return ONLY valid JSON tool calls. No prose, no markdown."
      },
      {
        role: "user",
        content: [
          "Allowed tools:",
          "edit, write, write_file, replace_in_file, append_file.",
          "Goal: produce the concrete file mutation needed to complete the task from the transcript below.",
          "Rules:",
          "- Do not emit read, list_files, or search_files.",
          "- Prefer edit with edits[] when the transcript contains exact old text.",
          "- Use write or write_file only for full rewrites or new files.",
          "- Return [] only if the transcript truly lacks enough information to edit safely."
        ].join("\n")
      },
      {
        role: "user",
        content: [`Original task: ${userTask}`, "", "Transcript:", this.tailToolResults(toolResults)].join("\n")
      }
    ];

    try {
      const recovered = await this.chatOnceWithTimeout(provider, recoveryMessages);
      const sanitized = this.stripReasoningArtifacts(recovered);
      const directCalls = filterMutationCalls(this.extractToolCalls(sanitized));
      if (directCalls.length > 0) {
        return directCalls;
      }
      const repairedCalls = await this.repairToolCalls(provider, sanitized);
      return filterMutationCalls(repairedCalls);
    } catch {
      return [];
    }
  }

  private async summarizeEditFailure(
    provider: ModelProvider,
    userTask: string,
    toolResults: string,
    toolErrors: string[]
  ): Promise<string> {
    const synthesisMessages: ProviderChatMessage[] = [
      {
        role: "system",
        content:
          "Explain why the edit task failed. Be concise, factual, and user-facing. Do not claim success. Do not ask for tools."
      },
      {
        role: "user",
        content: [
          `Original task: ${userTask}`,
          "",
          "Tool transcript:",
          this.tailToolResults(toolResults),
          "",
          "Tool errors:",
          toolErrors.length > 0 ? toolErrors.join("\n") : "(none)",
          "",
          "Summarize what happened, what Toki tried, and the most likely blocker."
        ].join("\n")
      }
    ];

    try {
      const candidate = this.sanitizeUserFacingText((await this.chatOnceWithTimeout(provider, synthesisMessages)).trim());
      if (candidate.length > 0) {
        return candidate;
      }
    } catch {
      // Fall through to local fallback.
    }

    const lastError = toolErrors.length > 0 ? ` Last error: ${toolErrors[toolErrors.length - 1]}.` : "";
    return `I could not apply an edit because no valid mutation call succeeded.${lastError}`;
  }

  private tailToolResults(toolResults: string, maxChars = 12000): string {
    if (toolResults.length <= maxChars) {
      return toolResults;
    }
    return `[tool transcript truncated]\n${toolResults.slice(-maxChars)}`;
  }

  private async synthesizeFinalResponseFromTools(
    provider: ModelProvider,
    userTask: string,
    toolResults: string
  ): Promise<string> {
    const synthesisMessages: ProviderChatMessage[] = [
      {
        role: "system",
        content:
          "You are Toki. Provide the final user-facing answer from tool outputs. Do not request more tools. Be concise and factual."
      },
      {
        role: "user",
        content: [
          `Original task: ${userTask}`,
          "",
          "Tool execution report:",
          toolResults,
          "",
          "Return only the final answer."
        ].join("\n")
      }
    ];

    try {
      const rawCandidate = this.stripReasoningArtifacts((await this.chatOnceWithTimeout(provider, synthesisMessages)).trim());
      const candidate = this.sanitizeUserFacingText(rawCandidate);
      if (candidate.length === 0) {
        return "Applied actions, but no final summary was returned. Ask for a summary of changes.";
      }
      if (this.extractToolCalls(rawCandidate).length > 0) {
        return "Applied actions, but no final summary was returned. Ask for a summary of changes.";
      }
      return candidate;
    } catch {
      return "Applied actions, but no final summary was returned. Ask for a summary of changes.";
    }
  }

  private inferDirectAnswerFromContext(userInput: string, contextItems: { path?: string; content: string }[]): string | null {
    const lower = userInput.toLowerCase();
    const asksFramework =
      (lower.includes("framework") || lower.includes("library") || lower.includes("stack")) &&
      (lower.includes("ui") || lower.includes("frontend") || lower.includes("tui") || lower.includes("project"));

    if (!asksFramework) {
      return null;
    }

    const packageLike = contextItems.filter(
      (item) => item.path?.toLowerCase().endsWith("package.json") || item.path?.toLowerCase().includes("readme")
    );
    const merged = packageLike.map((item) => item.content.toLowerCase()).join("\n");
    const hasInk = /\bink\b/.test(merged);
    const hasReact = /\breact\b/.test(merged);

    if (hasInk && hasReact) {
      return "This project’s UI framework is Ink with React.";
    }
    if (hasReact) {
      return "This project uses React for UI.";
    }
    if (hasInk) {
      return "This project uses Ink for its terminal UI.";
    }
    return null;
  }

  private resolveWorkspacePath(rawPath: string): string {
    const repoRoot = path.resolve(this.config.paths.repoDir);
    const target = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(repoRoot, rawPath);
    const relative = path.relative(repoRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path outside workspace is not allowed: ${rawPath}`);
    }
    return target;
  }

  private async executeToolCalls(calls: ToolCall[]): Promise<ToolExecutionOutput> {
    const displayLines: string[] = [];
    const reportLines: string[] = [];
    const errors: string[] = [];
    let mutationSuccessCount = 0;

    for (const call of calls) {
      displayLines.push(`* ${this.formatToolAction(call)}`);
      try {
        if (call.tool === "run_command") {
          if (typeof call.command !== "string" || call.command.trim().length === 0) {
            throw new Error("run_command requires command");
          }
          const commandCwd = this.resolveCommandCwd(call.cwd);
          const timeoutMs = this.clampCommandTimeout(call.timeout_ms);
          const result = await this.executeCommand(call.command, commandCwd, timeoutMs);
          displayLines.push(`  L EXIT ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`);
          if (result.stdout.length > 0) {
            displayLines.push(...this.renderCommandOutput("STDOUT", result.stdout, COMMAND_PREVIEW_MAX_CHARS));
          }
          if (result.stderr.length > 0) {
            displayLines.push(...this.renderCommandOutput("STDERR", result.stderr, COMMAND_PREVIEW_MAX_CHARS));
          }
          reportLines.push(
            [
              `run_command cwd=${commandCwd} timeout_ms=${timeoutMs} exit_code=${result.exitCode}${result.timedOut ? " timed_out=true" : ""}`,
              `command: ${call.command}`,
              "stdout:",
              this.truncateForReport(result.stdout),
              "stderr:",
              this.truncateForReport(result.stderr)
            ].join("\n")
          );
          continue;
        }

        const pathValue = call.path ?? ".";
        const absPath = this.resolveWorkspacePath(pathValue);

        if (call.tool === "read_file") {
          if (!(await fileExists(absPath))) {
            throw new Error("target file does not exist");
          }
          const content = await readTextFile(absPath);
          const lines = content.split(/\r?\n/);
          const start = Math.max(1, call.start_line ?? 1);
          const end = Math.min(lines.length, call.end_line ?? Math.min(lines.length, start + 199));
          const slice = lines.slice(start - 1, end);
          const rendered = slice.map((line, idx) => `${start + idx}: ${line}`).join("\n");
          displayLines.push(`  L READ ${call.path ?? "."} (${start}-${end})`);
          reportLines.push(`read_file ${call.path ?? "."} lines ${start}-${end}\n${rendered}`);
          continue;
        }

        if (call.tool === "list_files") {
          const max = this.clampMaxResults(call.max_results, 200, 50);
          const query = (call.query ?? "").toLowerCase();
          const all = await listFilesRecursive(absPath);
          const repoRoot = path.resolve(this.config.paths.repoDir);
          const relative = all
            .map((file) => path.relative(repoRoot, file).replace(/\\/g, "/"))
            .filter((value) => (query.length > 0 ? value.toLowerCase().includes(query) : true))
            .sort((left, right) => left.localeCompare(right))
            .slice(0, max);
          displayLines.push(`  L LISTED ${relative.length} path(s)`);
          reportLines.push(`list_files ${call.path ?? "."}\n${relative.join("\n") || "(none)"}`);
          continue;
        }

        if (call.tool === "search_files") {
          const query = (call.query ?? "").trim();
          if (query.length === 0) {
            throw new Error("search_files requires query");
          }
          const max = this.clampMaxResults(call.max_results, 200, 20);
          const targetStat = await stat(absPath);
          const files = targetStat.isDirectory() ? await listFilesRecursive(absPath) : [absPath];
          const repoRoot = path.resolve(this.config.paths.repoDir);
          const needle = query.toLowerCase();
          const exactMatches: string[] = [];
          const fallbackCandidates: SearchFallbackCandidate[] = [];
          const fallbackTokens = this.extractSearchTokens(query);
          const allowFallback = /\s/.test(query) && fallbackTokens.length > 0;
          for (const filePath of files) {
            if (exactMatches.length >= max) break;
            const body = await readTextFile(filePath);
            const rows = body.split(/\r?\n/);
            const rel = path.relative(repoRoot, filePath).replace(/\\/g, "/");
            const relLower = rel.toLowerCase();
            for (let i = 0; i < rows.length; i += 1) {
              const line = rows[i]!;
              const lineLower = line.toLowerCase();
              if (lineLower.includes(needle)) {
                exactMatches.push(`${rel}:${i + 1}: ${line}`);
                if (exactMatches.length >= max) break;
                continue;
              }
              if (allowFallback) {
                const tokenHits = fallbackTokens.reduce((count, token) => {
                  return lineLower.includes(token) || relLower.includes(token) ? count + 1 : count;
                }, 0);
                if (tokenHits > 0) {
                  fallbackCandidates.push({
                    path: rel,
                    lineNumber: i + 1,
                    line,
                    score: tokenHits
                  });
                }
              }
            }
          }
          const matches =
            exactMatches.length > 0
              ? exactMatches
              : fallbackCandidates
                  .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.lineNumber - right.lineNumber)
                  .slice(0, max)
                  .map((candidate) => `${candidate.path}:${candidate.lineNumber}: ${candidate.line}`);
          displayLines.push(`  L FOUND ${matches.length} match(es) for \"${query}\"`);
          for (const match of matches.slice(0, 5)) {
            displayLines.push(`  | ${match}`);
          }
          if (matches.length > 5) {
            displayLines.push(`  L ... ${matches.length - 5} more match(es) omitted`);
          }
          reportLines.push(`search_files ${call.path ?? "."} query=\"${query}\"\n${matches.join("\n") || "(none)"}`);
          continue;
        }

        if (!call.path || call.path.trim().length === 0) {
          throw new Error(`${call.tool} requires path`);
        }

        if (call.tool === "write_file") {
          if (typeof call.content !== "string") {
            throw new Error("write_file requires string content");
          }
          const before = (await fileExists(absPath)) ? await readTextFile(absPath) : "";
          await writeTextFile(absPath, call.content);
          mutationSuccessCount += 1;
          this.orchestrator.trackChangedFile(path.relative(this.config.paths.repoDir, absPath).replace(/\\/g, "/"));
          displayLines.push(`  L WROTE ${call.path} (${call.content.length} chars)`);
          const diff = this.renderDiff(before, call.content);
          if (diff.length > 0) {
            displayLines.push(...diff);
          }
          reportLines.push(`write_file ${call.path} (${call.content.length} chars)`);
          continue;
        }

        if (call.tool === "append_file") {
          if (typeof call.content !== "string") {
            throw new Error("append_file requires string content");
          }
          const existing = (await fileExists(absPath)) ? await readTextFile(absPath) : "";
          await writeTextFile(absPath, `${existing}${call.content}`);
          mutationSuccessCount += 1;
          this.orchestrator.trackChangedFile(path.relative(this.config.paths.repoDir, absPath).replace(/\\/g, "/"));
          displayLines.push(`  L APPENDED ${call.content.length} chars to ${call.path}`);
          const diff = this.renderDiff(existing, `${existing}${call.content}`);
          if (diff.length > 0) {
            displayLines.push(...diff);
          }
          reportLines.push(`append_file ${call.path} (+${call.content.length} chars)`);
          continue;
        }

        if (call.tool === "replace_in_file") {
          if (typeof call.find !== "string" || typeof call.replace !== "string") {
            throw new Error("replace_in_file requires string find and replace");
          }
          if (!(await fileExists(absPath))) {
            throw new Error("target file does not exist");
          }
          const before = await readTextFile(absPath);
          let after: string | null = null;
          if (before.includes(call.find)) {
            after = before.split(call.find).join(call.replace);
          } else {
            // Fallback for line-ending mismatches between model output and on-disk file.
            const beforeNormalized = before.replace(/\r\n/g, "\n");
            const findNormalized = call.find.replace(/\r\n/g, "\n");
            if (beforeNormalized.includes(findNormalized)) {
              const replacedNormalized = beforeNormalized.split(findNormalized).join(call.replace.replace(/\r\n/g, "\n"));
              after = before.includes("\r\n") ? replacedNormalized.replace(/\n/g, "\r\n") : replacedNormalized;
              reportLines.push(`replace_in_file ${call.path} (line-ending normalized fallback)`);
            }
          }
          if (after === null) {
            const previewLines = before.split(/\r?\n/).slice(0, 80).join("\n");
            const findPreview = call.find.split(/\r?\n/).slice(0, 20).join("\n");
            throw new Error(
              `find text not present. retry with exact text from file. FIND preview:\n${findPreview}\nFILE preview:\n${previewLines}`
            );
          }
          await writeTextFile(absPath, after);
          mutationSuccessCount += 1;
          this.orchestrator.trackChangedFile(path.relative(this.config.paths.repoDir, absPath).replace(/\\/g, "/"));
          displayLines.push(`  L UPDATED ${call.path}`);
          const diff = this.renderDiff(before, after);
          if (diff.length > 0) {
            displayLines.push(...diff);
          }
          if (!reportLines[reportLines.length - 1]?.startsWith(`replace_in_file ${call.path}`)) {
            reportLines.push(`replace_in_file ${call.path}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        displayLines.push(`  L ERROR: ${message}`);
        reportLines.push(`error ${call.tool} ${call.path ?? "."}: ${message}`);
        errors.push(`${call.tool} ${call.path ?? "."}: ${message}`);
      }
    }

    return {
      display: displayLines.join("\n"),
      report: reportLines.join("\n"),
      mutationSuccessCount,
      errors
    };
  }

  private resolveCommandCwd(rawCwd: string | undefined): string {
    if (!rawCwd || rawCwd.trim().length === 0) {
      return path.resolve(this.config.paths.repoDir);
    }
    return path.isAbsolute(rawCwd) ? path.resolve(rawCwd) : path.resolve(this.config.paths.repoDir, rawCwd);
  }

  private clampCommandTimeout(value: number | undefined): number {
    const base = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_COMMAND_TIMEOUT_MS;
    return Math.max(1, base);
  }

  private async executeCommand(
    command: string,
    cwd: string,
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    return await new Promise((resolve) => {
      execCallback(
        command,
        {
          cwd,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: MAX_COMMAND_BUFFER_BYTES
        },
        (error, stdout, stderr) => {
          const exitCode =
            error === null
              ? 0
              : typeof error === "object" && error !== null && "code" in error && typeof error.code === "number"
                ? error.code
                : 1;
          const timedOut =
            typeof error === "object" &&
            error !== null &&
            "killed" in error &&
            error.killed === true &&
            "signal" in error &&
            error.signal === "SIGTERM";

          resolve({
            stdout: stdout ?? "",
            stderr: stderr && stderr.length > 0 ? stderr : error instanceof Error ? error.message : "",
            exitCode,
            timedOut
          });
        }
      );
    });
  }

  private renderCommandOutput(label: string, value: string, maxChars: number): string[] {
    const truncated = this.truncateText(value, maxChars);
    const lines = truncated.length === 0 ? ["(empty)"] : truncated.split(/\r?\n/);
    const visible = lines.slice(0, COMMAND_PREVIEW_MAX_LINES);
    const rendered = [`  L ${label}`];
    for (const line of visible) {
      rendered.push(`  | ${line}`);
    }
    if (lines.length > visible.length) {
      rendered.push(`  L ... ${lines.length - visible.length} more line(s) omitted`);
    }
    return rendered;
  }

  private truncateForReport(value: string): string {
    const trimmed = this.truncateText(value, COMMAND_REPORT_MAX_CHARS);
    return trimmed.length > 0 ? trimmed : "(empty)";
  }

  private formatToolAction(call: ToolCall): string {
    if (call.tool === "read_file") {
      return `READ(${call.path ?? "."})`;
    }
    if (call.tool === "list_files") {
      return `LIST(${call.path ?? "."})`;
    }
    if (call.tool === "search_files") {
      return `SEARCH(${call.path ?? "."}, \"${call.query ?? ""}\")`;
    }
    if (call.tool === "write_file") {
      return `WRITE(${call.path ?? "."})`;
    }
    if (call.tool === "append_file") {
      return `APPEND(${call.path ?? "."})`;
    }
    if (call.tool === "run_command") {
      const summarized = this.summarizeInline(call.command ?? "", 72);
      return `RUN(${JSON.stringify(summarized)})`;
    }
    return `UPDATE(${call.path ?? "."})`;
  }

  private clampMaxResults(value: number | undefined, maxLimit: number, fallback: number): number {
    const base = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.max(1, Math.min(maxLimit, base));
  }

  private renderDiff(before: string, after: string): string[] {
    const beforeLines = before.split(/\r?\n/);
    const afterLines = after.split(/\r?\n/);
    const maxPreview = 80;
    const out: string[] = [];
    let unchangedPrefix = 0;
    while (
      unchangedPrefix < beforeLines.length &&
      unchangedPrefix < afterLines.length &&
      beforeLines[unchangedPrefix] === afterLines[unchangedPrefix]
    ) {
      unchangedPrefix += 1;
    }

    let unchangedSuffix = 0;
    while (
      unchangedSuffix < beforeLines.length - unchangedPrefix &&
      unchangedSuffix < afterLines.length - unchangedPrefix &&
      beforeLines[beforeLines.length - 1 - unchangedSuffix] === afterLines[afterLines.length - 1 - unchangedSuffix]
    ) {
      unchangedSuffix += 1;
    }

    const removed = beforeLines.slice(unchangedPrefix, beforeLines.length - unchangedSuffix);
    const added = afterLines.slice(unchangedPrefix, afterLines.length - unchangedSuffix);
    if (removed.length === 0 && added.length === 0) {
      return out;
    }

    out.push("  L @@ diff @@");
    const shownRemoved = removed.slice(0, maxPreview);
    const shownAdded = added.slice(0, maxPreview);
    for (const line of shownRemoved) {
      out.push(`  - ${line}`);
    }
    for (const line of shownAdded) {
      out.push(`  + ${line}`);
    }
    if (removed.length > maxPreview || added.length > maxPreview) {
      out.push(`  L ... diff truncated to ${maxPreview} line(s) per side`);
    }
    return out;
  }

  private truncateText(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
      return value;
    }
    return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
  }

  private extractSearchTokens(query: string): string[] {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !SEARCH_TOKEN_STOPWORDS.has(token));

    return [...new Set(tokens)];
  }

  private summarizeInline(value: string, maxChars: number): string {
    const compact = value.replace(/\s+/g, " ").trim();
    if (compact.length <= maxChars) {
      return compact;
    }
    return `${compact.slice(0, maxChars - 3)}...`;
  }
}
