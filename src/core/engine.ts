import { buildTaskFrame } from "./task/taskFrame.js";
import path from "node:path";
import { ContextGraph } from "./graph/contextGraph.js";
import { ContextBroker } from "./broker/contextBroker.js";
import { ContextLedger } from "./ledger/ledger.js";
import { Compressor } from "./compressor/compressor.js";
import { buildPrompt } from "./orchestrator/promptBuilder.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { loadConfig, modeToCeiling, ResolvedConfig, saveGlobalConfig } from "./config.js";
import { ChatChunk, ProviderChatMessage } from "./types.js";
import { parseToolCallsFromText, ToolCall } from "./toolCalls.js";
import { ProviderListItem, ProviderRegistry } from "../providers/registry.js";
import { fileExists, listFilesRecursive, readTextFile, writeTextFile } from "../utils/fs.js";
import { ModelProvider } from "../providers/base.js";

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
}

interface ModelRoundOutput {
  content: string;
}

const MINIMAX_MIN_TIMEOUT_MS = 120000;

const SYSTEM_PROMPT = [
  "You are Toki, a deterministic coding assistant.",
  "Only rely on provided context and explicitly state uncertainty when context is missing.",
  "Prefer concise, actionable output with minimal filler."
].join(" ");

const TOOL_INSTRUCTIONS = [
  "You may use tools to inspect and edit files when needed.",
  "When you need actions, respond ONLY with <tool_calls>...</tool_calls> where content is strict JSON.",
  "Allowed tools:",
  '- {"tool":"read_file","path":"relative/or/absolute","start_line":1,"end_line":120}',
  '- {"tool":"list_files","path":"relative/or/absolute/dir","query":"optional filename filter","max_results":50}',
  '- {"tool":"search_files","path":"relative/or/absolute/dir","query":"text to find","max_results":20}',
  '- {"tool":"write_file","path":"relative/or/absolute","content":"full file content"}',
  '- {"tool":"append_file","path":"relative/or/absolute","content":"text to append"}',
  '- {"tool":"replace_in_file","path":"relative/or/absolute","find":"old text","replace":"new text"}',
  "You may return either one JSON object or a JSON array of objects.",
  "Do not wrap tool JSON in markdown fences.",
  "When no more edits are required, return the final user-facing answer as plain text."
].join(" ");

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

    const maxToolRounds = this.config.global.runtime.maxToolRounds;
    const maxEditRetries = this.config.global.runtime.editToolCallRetries;

    for (let round = 0; round < maxToolRounds; round += 1) {
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
      const candidate = result.content;
      const calls = this.extractToolCalls(candidate);
      const recoveredCalls =
        calls.length === 0 && task.needsEdit ? await this.repairToolCalls(provider, candidate) : [];
      const effectiveCalls = calls.length > 0 ? calls : recoveredCalls;

      if (effectiveCalls.length === 0) {
        if (task.needsEdit && !executedAnyTools && forcedToolRetries < maxEditRetries) {
          forcedToolRetries += 1;
          const warning = `Model returned no valid tool calls on edit task (retry ${forcedToolRetries}).`;
          toolResults = `${toolResults === "(none)" ? "" : `${toolResults}\n`}${warning}`.trim();
          onChunk(`* TOOLING(.)\n  L INFO ${warning}\n`);
          continue;
        }
        if (task.needsEdit && !executedAnyTools) {
          response =
            "No executable tool call was produced for this edit task. Refusing plain-text fallback to avoid silent no-op.";
          onChunk("* TOOLING(.)\n  L ERROR Model did not return executable tool JSON for an edit task.\n");
          break;
        }
        response = candidate;
        break;
      }

      if (calls.length === 0 && recoveredCalls.length > 0) {
        onChunk("* TOOLING(.)\n  L INFO Recovered valid tool JSON from model output\n");
      }

      executedAnyTools = true;
      const execution = await this.executeToolCalls(effectiveCalls);
      onChunk(`${execution.display}\n`);
      toolResults = `${toolResults === "(none)" ? "" : `${toolResults}\n`}[round ${round + 1}]\n${execution.report}`.trim();
      this.orchestrator.noteDecision(`Executed ${effectiveCalls.length} tool call(s) in round ${round + 1}`);
    }

    if (response.length === 0) {
      if (executedAnyTools) {
        response = await this.synthesizeFinalResponseFromTools(provider, task.raw, toolResults);
      } else {
        response =
          this.inferDirectAnswerFromContext(userInput, selection.items) ??
          "I could not produce a final response after tool execution rounds.";
      }
    }

    if (response.length > 0) {
      onChunk(response);
    }

    this.history.push({ role: "user", content: userInput });
    this.history.push({ role: "assistant", content: response });
    this.orchestrator.markCompleted(`turn ${this.turn} responded`);
    this.orchestrator.advance(task);

    const contextLine = `context: ${selection.receipt.mode} / ${(selection.receipt.usedTokens / 1000).toFixed(
      1
    )}k used / saved ~${(selection.receipt.savedTokens / 1000).toFixed(1)}k`;

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
    return parseToolCallsFromText(text);
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
          "read_file, list_files, search_files, write_file, append_file, replace_in_file.",
          "If file creation is requested, emit write_file with full content.",
          "If you cannot infer valid arguments, return [] exactly."
        ].join("\n")
      },
      {
        role: "user",
        content: `Model output to convert:\n${rawOutput}`
      }
    ];

    try {
      const repaired = await this.chatOnceWithTimeout(provider, repairMessages);
      return this.extractToolCalls(repaired);
    } catch {
      return [];
    }
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
      const candidate = (await this.chatOnceWithTimeout(provider, synthesisMessages)).trim();
      if (candidate.length === 0) {
        return "Applied actions, but no final summary was returned. Ask for a summary of changes.";
      }
      if (this.extractToolCalls(candidate).length > 0) {
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

    for (const call of calls) {
      displayLines.push(`* ${this.formatToolAction(call)}`);
      try {
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
          const files = await listFilesRecursive(absPath);
          const repoRoot = path.resolve(this.config.paths.repoDir);
          const needle = query.toLowerCase();
          const matches: string[] = [];
          for (const filePath of files) {
            if (matches.length >= max) break;
            const body = await readTextFile(filePath);
            const rows = body.split(/\r?\n/);
            for (let i = 0; i < rows.length; i += 1) {
              if (rows[i]!.toLowerCase().includes(needle)) {
                const rel = path.relative(repoRoot, filePath).replace(/\\/g, "/");
                matches.push(`${rel}:${i + 1}: ${rows[i]}`);
                if (matches.length >= max) break;
              }
            }
          }
          displayLines.push(`  L FOUND ${matches.length} match(es) for \"${query}\"`);
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
          if (!before.includes(call.find)) {
            throw new Error("find text not present");
          }
          const after = before.split(call.find).join(call.replace);
          await writeTextFile(absPath, after);
          this.orchestrator.trackChangedFile(path.relative(this.config.paths.repoDir, absPath).replace(/\\/g, "/"));
          displayLines.push(`  L UPDATED ${call.path}`);
          const diff = this.renderDiff(before, after);
          if (diff.length > 0) {
            displayLines.push(...diff);
          }
          reportLines.push(`replace_in_file ${call.path}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        displayLines.push(`  L ERROR: ${message}`);
        reportLines.push(`error ${call.tool} ${call.path ?? "."}: ${message}`);
      }
    }

    return {
      display: displayLines.join("\n"),
      report: reportLines.join("\n")
    };
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
}
