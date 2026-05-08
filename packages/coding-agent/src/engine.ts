// @ts-nocheck
import { buildTaskFrame } from "./task/taskFrame.js";
import path from "node:path";
import os from "node:os";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluateEditLoopRound, isMutationCall, parseToolCallsFromText } from "@toki/agent-core";
import { ProviderRegistry } from "@toki/providers";
import { fileExists, readTextFile } from "@toki/shared";
import { ContextGraph } from "./graph/contextGraph.js";
import { ContextBroker } from "./broker/contextBroker.js";
import { ContextLedger } from "./ledger/ledger.js";
import { Compressor } from "./compressor/compressor.js";
import { buildSystemPrompt } from "./core/system-prompt.js";
import { executeToolCalls } from "./core/tool-runtime.js";
import { createCodingToolDefinitions } from "./core/tools/index.js";
import { buildPrompt } from "./orchestrator/promptBuilder.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { loadConfig, modeToCeiling, saveGlobalConfig } from "./config.js";
const MINIMAX_MIN_TIMEOUT_MS = 120000;
const execFileAsync = promisify(execFile);
function formatTokenCount(tokens) {
    if (!Number.isFinite(tokens) || tokens <= 0) {
        return "0t";
    }
    if (tokens < 1000) {
        return `${Math.round(tokens)}t`;
    }
    return `${(tokens / 1000).toFixed(1)}k`;
}
function isMutationTool(call) {
    return isMutationCall(call);
}
function shouldTrackDiscoveredPath(call) {
    return call.tool === "read" || isMutationTool(call);
}
function filterMutationCalls(calls) {
    return calls.filter(isMutationTool);
}
function filterEditRecoveryCalls(calls) {
    return calls.filter((call) => call.tool === "read" || isMutationTool(call));
}
function filterExplorationCallsForEditRecovery(calls) {
    return calls.filter((call) => call.tool === "read" || isMutationTool(call));
}
function resolveRuntimeEnvironment() {
    const platform = os.platform();
    const inferredShell = process.env.TOKI_SHELL ??
        (process.env.PSModulePath ? "powershell" : undefined) ??
        process.env.SHELL ??
        process.env.ComSpec;
    if (platform === "win32") {
        if (typeof inferredShell === "string" && inferredShell.toLowerCase().includes("powershell")) {
            return {
                platform,
                shell: inferredShell,
                shellDisplayName: "Windows PowerShell"
            };
        }
        return {
            platform,
            ...(typeof inferredShell === "string" ? { shell: inferredShell } : {}),
            shellDisplayName: typeof inferredShell === "string" && inferredShell.length > 0 ? inferredShell : "Windows shell"
        };
    }
    return {
        platform,
        ...(typeof inferredShell === "string" ? { shell: inferredShell } : {}),
        shellDisplayName: typeof inferredShell === "string" && inferredShell.length > 0 ? inferredShell : "POSIX shell"
    };
}
export class TokiEngine {
    config;
    graph;
    broker;
    ledger;
    compressor;
    orchestrator;
    providers;
    providerId = "nim";
    modelId = "llama-3.1-nemotron-ultra";
    turn = 0;
    history;
    lastBudgetUsed = 0;
    lastBudgetCeiling = 0;
    constructor() {
        this.ledger = new ContextLedger();
        this.compressor = new Compressor();
        this.orchestrator = new Orchestrator();
        this.history = [];
    }
    async initialize(input) {
        this.config = await loadConfig(input.cwd);
        this.providerId = this.config.global.defaultProvider;
        this.modelId = this.config.global.defaultModel;
        this.providers = new ProviderRegistry(this.config.global);
        this.graph = new ContextGraph(input.cwd, this.config.repo, this.config.paths.repoIndexDir);
        this.broker = new ContextBroker(this.config.global.mode);
        this.lastBudgetCeiling = modeToCeiling(this.broker.getMode(), this.config.global);
        await this.graph.initialize();
    }
    getHeaderInfo() {
        return {
            repo: path.basename(this.config.paths.repoDir),
            provider: this.providerId,
            model: this.modelId,
            mode: this.broker.getMode()
        };
    }
    getLedger() {
        return this.ledger;
    }
    getBroker() {
        return this.broker;
    }
    getCurrentModel() {
        return this.modelId;
    }
    async setModel(modelId) {
        const available = await this.listModels();
        if (!available.some((item) => item.id === modelId)) {
            throw new Error(`Model not available: ${modelId}`);
        }
        this.modelId = modelId;
        this.config.global.defaultModel = modelId;
        await saveGlobalConfig(this.config.global, this.config.paths.globalConfigPath);
    }
    async listModels() {
        return this.providers.get(this.providerId).listModels();
    }
    getCurrentProvider() {
        return this.providerId;
    }
    listProviders() {
        return this.providers.listProviders();
    }
    getProviderRequirements(providerId) {
        return this.providers.getDefinition(providerId)?.requiredCredentials ?? [];
    }
    providerNeedsCredentials(providerId) {
        return !this.providers.isConfigured(providerId);
    }
    async switchProvider(providerId) {
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
    async setProviderCredential(providerId, fieldKey, value) {
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
    clearConversation() {
        this.history = [];
        this.ledger.clear();
    }
    getBudgetSummary() {
        return {
            mode: this.broker.getMode(),
            used: this.lastBudgetUsed,
            ceiling: this.lastBudgetCeiling
        };
    }
    async runTurn(userInput, onChunk) {
        this.turn += 1;
        const task = buildTaskFrame(userInput);
        const phase = this.orchestrator.currentPhase();
        const selection = await this.broker.selectContext(this.turn, task, this.graph, this.config.global);
        this.ledger.record(selection.receipt);
        this.lastBudgetUsed = selection.receipt.usedTokens;
        this.lastBudgetCeiling = selection.receipt.ceiling;
        const repoRules = (await fileExists(this.config.paths.repoRulesPath)) === true
            ? await readTextFile(this.config.paths.repoRulesPath)
            : "";
        const compressedHistory = this.compressor.compressHistory(this.history, 1400);
        const provider = this.providers.get(this.providerId);
        let response = "";
        let toolResults = "(none)";
        let executedAnyTools = false;
        let forcedToolRetries = 0;
        let successfulMutations = 0;
        const toolErrors = [];
        const discoveredPaths = new Set();
        let editExplorationOnlyRounds = 0;
        const activeTools = createCodingToolDefinitions(this.config.paths.repoDir);
        const runtimeEnvironment = resolveRuntimeEnvironment();
        const systemPrompt = buildSystemPrompt({
            cwd: this.config.paths.repoDir,
            selectedTools: activeTools.map((tool) => tool.name),
            toolSnippets: Object.fromEntries(activeTools.map((tool) => [tool.name, tool.promptSnippet])),
            runtimeEnvironment,
            promptGuidelines: [
                ...activeTools.flatMap((tool) => tool.promptGuidelines ?? []),
                "When you need actions, respond ONLY with <tool_calls>...</tool_calls> where content is strict JSON.",
                "Never include <think>...</think> or any hidden reasoning text.",
                "Never show raw tool protocol such as <tool_calls>, [TOOL_CALL], or object literals to the user.",
                "When the user asks about recent changes, inspect the repo first with bash using commands such as git status --short, git diff --stat, or git log --oneline -10 before drafting an answer.",
                "For edit tasks, avoid broad search loops. Prefer reading likely files directly, then edit.",
                "If grep returns 0 for a multi-word phrase, retry with 1-3 concrete identifiers or keywords.",
                "When no more edits are required, return the final user-facing answer as plain text."
            ]
        });
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
            const editRecoveryInstructions = task.needsEdit && successfulMutations === 0 && toolResults !== "(none)"
                ? "No file mutation has succeeded yet. Your next response must move toward a concrete edit. Do not stop at grep/find/ls loops. Prefer read on the most likely target, then edit or write."
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
                instructions: "Answer the task using only available context. If missing context, request exact files/commands needed. " +
                    editEnforcement +
                    " " +
                    editRecoveryInstructions,
                successCriteria: "Return the most useful next response for this turn."
            });
            const messages = [
                { role: "system", content: systemPrompt },
                {
                    role: "system",
                    content: compressedHistory.content.length > 0
                        ? `Conversation history snapshot:\n${compressedHistory.content}`
                        : "(no history)"
                },
                { role: "user", content: prompt }
            ];
            let result;
            try {
                result = await this.streamRoundWithTimeout(provider, messages, onChunk);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                onChunk(`\n* MODEL RETRY Fallback to non-stream after stream error: ${message}\n`);
                const fallbackText = await this.chatOnceWithTimeout(provider, messages);
                result = { content: fallbackText };
            }
            const candidate = this.stripReasoningArtifacts(result.content);
            const calls = this.extractToolCalls(candidate);
            const repairedFromCandidate = calls.length === 0 ? await this.repairToolCalls(provider, candidate) : [];
            const recoveredCalls = task.needsEdit
                ? await this.filterSafeEditRecoveryCalls(filterEditRecoveryCalls(repairedFromCandidate))
                : repairedFromCandidate;
            const recoveryCalls = calls.length === 0 && recoveredCalls.length === 0 && task.needsEdit && successfulMutations === 0
                ? await this.recoverEditToolCalls(provider, task, toolResults)
                : [];
            const postMutationRecoveryCalls = calls.length === 0 && recoveredCalls.length === 0 && task.needsEdit && successfulMutations > 0
                ? await this.recoverPostMutationToolCalls(provider, candidate)
                : [];
            const effectiveCalls = calls.length > 0
                ? calls
                : recoveredCalls.length > 0
                    ? recoveredCalls
                    : recoveryCalls.length > 0
                    ? recoveryCalls
                    : postMutationRecoveryCalls.length > 0
                        ? postMutationRecoveryCalls
                        : [];
            if (effectiveCalls.length === 0) {
                if (task.needsEdit && successfulMutations === 0 && forcedToolRetries < maxEditRetries) {
                    forcedToolRetries += 1;
                    const lastError = toolErrors.length > 0 ? toolErrors[toolErrors.length - 1] : null;
                    const warning = lastError
                        ? `No valid edit tool calls after failure (retry ${forcedToolRetries}). Last error: ${lastError}. Retry by reading target file and applying exact edits or write.`
                        : `Model returned no valid tool calls on edit task (retry ${forcedToolRetries}).`;
                    toolResults = `${toolResults === "(none)" ? "" : `${toolResults}\n`}${warning}`.trim();
                    continue;
                }
                if (task.needsEdit && successfulMutations === 0) {
                    onChunk("* TOOLING(.)\n  L ERROR No successful file mutation was produced for an edit task.\n");
                    break;
                }
                const sanitizedCandidate = this.sanitizeUserFacingText(candidate);
                if (task.needsEdit && successfulMutations > 0) {
                    const candidateStillLooksLikeDraft = this.looksLikeEditContinuation(sanitizedCandidate) || /```/.test(sanitizedCandidate);
                    if (sanitizedCandidate.length === 0 || candidateStillLooksLikeDraft || this.extractToolCalls(sanitizedCandidate).length > 0) {
                        break;
                    }
                }
                response = sanitizedCandidate;
                break;
            }
            if (calls.length === 0 && recoveredCalls.length > 0) {
                onChunk("* TOOLING(.)\n  L INFO Recovered valid tool JSON from model output\n");
            }
            if (calls.length === 0 && recoveryCalls.length > 0) {
                onChunk("* TOOLING(.)\n  L INFO Generated recovery tool calls from failed edit transcript\n");
            }
            if (calls.length === 0 && postMutationRecoveryCalls.length > 0) {
                onChunk("* TOOLING(.)\n  L INFO Converted post-edit prose back into mutation tool calls\n");
            }
            executedAnyTools = true;
            for (const call of effectiveCalls) {
                if (shouldTrackDiscoveredPath(call) && call.path && call.path.trim().length > 0) {
                    discoveredPaths.add(call.path);
                }
            }
            const execution = await executeToolCalls(this.config.paths.repoDir, effectiveCalls);
            successfulMutations += execution.mutationSuccessCount;
            toolErrors.push(...execution.errors);
            onChunk(`${execution.display}\n`);
            toolResults = `${toolResults === "(none)" ? "" : `${toolResults}\n`}[round ${round + 1}]\n${execution.report}`.trim();
            if (task.needsEdit && successfulMutations === 0 && execution.mutationSuccessCount === 0) {
                const mutationIntentSeen = effectiveCalls.some(isMutationTool);
                const repairHint = execution.errors.length > 0
                    ? "Repair hint: previous edit call failed. Read the exact target file and retry with exact oldText/newText blocks, or use write with full content."
                    : mutationIntentSeen
                        ? "Repair hint: a mutation was attempted but did not succeed. Retry with exact file text or escalate to write."
                        : "Repair hint: no file changes yet. Continue with concrete edit calls (edit/write), not only grep/find/ls/read calls.";
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
        if (task.needsEdit && successfulMutations === 0 && this.isReadmeGitUpdateTask(task)) {
            const fallback = await this.applyDeterministicReadmeGitUpdate(toolResults, onChunk);
            if (fallback !== null) {
                toolResults = `${toolResults === "(none)" ? "" : `${toolResults}\n`}[deterministic readme fallback]\n${fallback.report}`.trim();
                successfulMutations += fallback.mutationSuccessCount;
                toolErrors.push(...fallback.errors);
                if (fallback.mutationSuccessCount > 0) {
                    executedAnyTools = true;
                }
            }
        }
        if (response.length === 0) {
            if (task.needsEdit && successfulMutations === 0) {
                response = await this.summarizeEditFailure(provider, task.objective, toolResults, toolErrors);
            }
            else if (executedAnyTools) {
                response = await this.synthesizeFinalResponseFromTools(provider, task.objective, toolResults);
            }
            else {
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
        const contextLine = `context: ${selection.receipt.mode} / ${formatTokenCount(selection.receipt.usedTokens)} used / saved ~${formatTokenCount(selection.receipt.savedTokens)}`;
        return {
            response,
            contextLine
        };
    }
    isReadmeGitUpdateTask(task) {
        const raw = `${task.objective ?? ""} ${task.raw ?? ""}`.toLowerCase();
        return raw.includes("readme") && raw.includes("git");
    }
    async runGitCommand(args) {
        try {
            const result = await execFileAsync("git", args, {
                cwd: this.config.paths.repoDir,
                windowsHide: true,
                maxBuffer: 1024 * 1024
            });
            return typeof result.stdout === "string" ? result.stdout : "";
        }
        catch {
            return "";
        }
    }
    async applyDeterministicReadmeGitUpdate(toolResults, onChunk) {
        const readmePath = "README.md";
        if (!(await this.isSafeRecoveryPath(readmePath, "write"))) {
            return null;
        }
        const diffStat = (await this.runGitCommand(["diff", "--stat"])).trim();
        const statusShort = diffStat.length > 0 ? "" : (await this.runGitCommand(["status", "--short"])).trim();
        const summaryBody = diffStat.length > 0 ? diffStat : statusShort;
        if (summaryBody.length === 0) {
            return null;
        }
        const absoluteReadmePath = this.resolveWorkspacePath(readmePath);
        let current;
        try {
            current = await readTextFile(absoluteReadmePath);
        }
        catch {
            return null;
        }
        const generatedDate = new Date().toISOString().slice(0, 10);
        const section = [
            "## Current Repository Changes",
            `Generated from git output on ${generatedDate}.`,
            "",
            "```text",
            summaryBody,
            "```"
        ].join("\n");
        const sectionPattern = /\n## Current Repository Changes[\s\S]*?(?=\n##\s|\s*$)/;
        const base = current.trimEnd();
        const next = sectionPattern.test(base) ? base.replace(sectionPattern, `\n${section}`) : `${base}\n\n${section}\n`;
        if (next === current) {
            return null;
        }
        onChunk("* TOOLING(.)\n  L INFO Applying deterministic README update from current git changes\n");
        const execution = await this.executeToolCalls([{ tool: "write", path: readmePath, content: next }]);
        onChunk(`${execution.display}\n`);
        return {
            mutationSuccessCount: execution.mutationSuccessCount,
            report: execution.report,
            errors: execution.errors
        };
    }
    async ensureModelCompatibleWithCurrentProvider() {
        if (!this.providers.isConfigured(this.providerId)) {
            return;
        }
        try {
            const available = await this.providers.get(this.providerId).listModels();
            if (available.length === 0) {
                return;
            }
            if (!available.some((item) => item.id === this.modelId)) {
                this.modelId = available[0].id;
                this.config.global.defaultModel = this.modelId;
            }
        }
        catch {
            // Keep current model if the provider cannot list models.
        }
    }
    extractToolCalls(text) {
        return parseToolCallsFromText(this.stripReasoningArtifacts(text));
    }
    stripReasoningArtifacts(text) {
        if (text.length === 0) {
            return text;
        }
        return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    }
    sanitizeUserFacingText(text) {
        if (text.length === 0) {
            return text;
        }
        return this.stripReasoningArtifacts(text)
            .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, "")
            .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
            .replace(/\[tool_calls?\][\s\S]*?\[\/tool_calls?\]/gi, "")
            .replace(/^\s*\{\s*"?tool"?\s*:\s*["']?.*$/gim, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }
    async streamRoundWithTimeout(provider, messages, onChunk) {
        const timeoutMs = this.getEffectiveModelTimeoutMs();
        const retries = this.config.global.runtime.modelRoundRetries;
        let lastError = new Error("Model stream failed.");
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
                return await this.streamOnceWithTimeout(provider, messages, onChunk, timeoutMs);
            }
            catch (error) {
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
    async chatOnceWithTimeout(provider, messages) {
        const timeoutMs = this.getEffectiveModelTimeoutMs();
        const retries = this.config.global.runtime.modelRoundRetries;
        let lastError = new Error("Model chat failed.");
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
                const chatPromise = provider.chat(messages, {
                    model: this.modelId,
                    temperature: 0
                });
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error(`Model request timed out after ${timeoutMs}ms`)), timeoutMs);
                });
                const result = await Promise.race([chatPromise, timeoutPromise]);
                return result.text;
            }
            catch (error) {
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
    async streamOnceWithTimeout(provider, messages, onChunk, timeoutMs) {
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
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Model request timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        return Promise.race([streamPromise, timeoutPromise]);
    }
    getEffectiveModelTimeoutMs() {
        const configured = this.config.global.runtime.modelRoundTimeoutMs;
        if (this.providerId === "minimax" && configured < MINIMAX_MIN_TIMEOUT_MS) {
            return MINIMAX_MIN_TIMEOUT_MS;
        }
        return configured;
    }
    isRetryableModelError(error) {
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
    getRetryDelayMs(attempt) {
        const base = this.config.global.runtime.modelRoundRetryBackoffMs;
        const backoff = base * Math.max(1, 2 ** attempt);
        const jitter = Math.floor(Math.random() * 300);
        return backoff + jitter;
    }
    async sleep(ms) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }
    async attemptForcedMutationRecovery(provider, task, selectedContext, discoveredPaths, toolResults, onChunk) {
        let nextToolResults = toolResults;
        const errors = [];
        const forcedCalls = await this.recoverMutationToolCalls(provider, task, nextToolResults);
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
        const secondForcedCalls = await this.recoverMutationToolCalls(provider, task, nextToolResults);
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
    async buildForcedRecoveryReadCalls(task, selectedContext, discoveredPaths, toolResults) {
        const alreadyRead = new Set([...toolResults.matchAll(/(?:^|\n)read\s+([^\n]+?)\s+lines\s+\d+-\d+/g)].map((match) => match[1]?.trim() ?? ""));
        const prioritizedGroups = [
            [...discoveredPaths].filter((value) => value.trim().length > 0),
            task.entities.paths.filter((value) => value.trim().length > 0),
            selectedContext.map((item) => item.path).filter((value) => typeof value === "string" && value.trim().length > 0)
        ];
        const buildCalls = async (allowRereads) => {
            const calls = [];
            const seenCandidates = new Set();
            for (const group of prioritizedGroups) {
                for (const candidate of group) {
                    if (seenCandidates.has(candidate)) {
                        continue;
                    }
                    if (!allowRereads && alreadyRead.has(candidate)) {
                        continue;
                    }
                    seenCandidates.add(candidate);
                    try {
                        if (!(await this.isSafeRecoveryPath(candidate, "read"))) {
                            continue;
                        }
                        calls.push({
                            tool: "read",
                            path: candidate,
                            offset: 1,
                            limit: 250
                        });
                    }
                    catch {
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
        };
        const unreadCalls = await buildCalls(false);
        if (unreadCalls.length > 0) {
            return unreadCalls;
        }
        // Recovery may need a fresh read near the transcript tail even if the file
        // was already read earlier in a long exploration loop.
        return await buildCalls(true);
    }
    async repairToolCalls(provider, rawOutput) {
        const repairMessages = [
            {
                role: "system",
                content: "Convert assistant text into executable tool calls. Return ONLY valid JSON (object or array). No prose, no markdown."
            },
            {
                role: "user",
                content: [
                    "Allowed tools:",
                    "read, bash, edit, write, grep, find, ls.",
                    "If file creation is requested, emit write with full content.",
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
        }
        catch {
            return [];
        }
    }
    async recoverEditToolCalls(provider, task, toolResults) {
        const userTask = this.buildRecoveryTaskSummary(task);
        const recoveryMessages = [
            {
                role: "system",
                content: "You are repairing a failed coding-agent edit loop. Return ONLY valid JSON tool calls. No prose, no markdown."
            },
            {
                role: "user",
                content: [
                    "Allowed tools:",
                    "read, edit, write, grep, find, ls.",
                    "Goal: recover from failed edit attempts and produce the next best tool call batch.",
                    "Rules:",
                    "- Prefer read on the most likely target file, then edit or write.",
                    "- Avoid broad grep/find/ls loops unless you truly do not know the file.",
                    "- Do not emit bash during edit recovery. Use file tools only.",
                    "- If grep returned 0 for a multi-word phrase, break it into concrete identifiers or keywords.",
                    "- If a previous edit failed, use the file/error previews to choose exact oldText/newText values.",
                    "- If exact replacement remains uncertain, emit write with full corrected file content.",
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
            const directCalls = await this.filterSafeEditRecoveryCalls(filterExplorationCallsForEditRecovery(this.extractToolCalls(sanitized)));
            if (directCalls.length > 0) {
                return directCalls;
            }
            const repairedCalls = await this.repairToolCalls(provider, sanitized);
            return await this.filterSafeEditRecoveryCalls(filterExplorationCallsForEditRecovery(repairedCalls));
        }
        catch {
            return [];
        }
    }
    async recoverMutationToolCalls(provider, task, toolResults) {
        const userTask = this.buildRecoveryTaskSummary(task);
        const recoveryMessages = [
            {
                role: "system",
                content: "You are repairing a stalled coding-agent edit turn. Return ONLY valid JSON tool calls. No prose, no markdown."
            },
            {
                role: "user",
                content: [
                    "Allowed tools:",
                    "edit, write.",
                    "Goal: produce the concrete file mutation needed to complete the task from the transcript below.",
                    "Rules:",
                    "- Do not emit read, grep, find, ls, or bash.",
                    "- Prefer edit with edits[] when the transcript contains exact old text.",
                    "- Use write only for full rewrites or new files.",
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
            const directCalls = await this.filterSafeMutationCalls(filterMutationCalls(this.extractToolCalls(sanitized)));
            if (directCalls.length > 0) {
                return directCalls;
            }
            const repairedCalls = await this.repairToolCalls(provider, sanitized);
            return await this.filterSafeMutationCalls(filterMutationCalls(repairedCalls));
        }
        catch {
            return [];
        }
    }
    looksLikeEditContinuation(text) {
        const trimmed = text.trim();
        if (trimmed.length === 0) {
            return false;
        }
        const nonEmptyLines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
        if (nonEmptyLines.length < 3) {
            return false;
        }
        return (/```/.test(trimmed) ||
            /^\s*#{1,6}\s/m.test(trimmed) ||
            /^\s*[-+]\s/m.test(trimmed) ||
            /\b(?:oldText|newText|replace|rewrite|section)\b/i.test(trimmed));
    }
    async recoverPostMutationToolCalls(provider, rawOutput) {
        const sanitized = this.stripReasoningArtifacts(rawOutput);
        if (!this.looksLikeEditContinuation(sanitized)) {
            return [];
        }
        const directCalls = await this.filterSafeMutationCalls(filterMutationCalls(this.extractToolCalls(sanitized)));
        if (directCalls.length > 0) {
            return directCalls;
        }
        const repairedCalls = await this.repairToolCalls(provider, sanitized);
        return await this.filterSafeMutationCalls(filterMutationCalls(repairedCalls));
    }
    async summarizeEditFailure(provider, userTask, toolResults, toolErrors) {
        const synthesisMessages = [
            {
                role: "system",
                content: "Explain why the edit task failed. Be concise, factual, and user-facing. Do not claim success. Do not ask for tools."
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
        }
        catch {
            // Fall through to local fallback.
        }
        const lastError = toolErrors.length > 0 ? ` Last error: ${toolErrors[toolErrors.length - 1]}.` : "";
        return `I could not apply an edit because no valid mutation call succeeded.${lastError}`;
    }
    tailToolResults(toolResults, maxChars = 12000) {
        if (toolResults.length <= maxChars) {
            return toolResults;
        }
        return `[tool transcript truncated]\n${toolResults.slice(-maxChars)}`;
    }
    async synthesizeFinalResponseFromTools(provider, userTask, toolResults) {
        const synthesisMessages = [
            {
                role: "system",
                content: "You are Toki. Provide the final user-facing answer from tool outputs. Do not request more tools. Be concise and factual."
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
                return this.buildToolSummaryFallback(toolResults);
            }
            if (this.extractToolCalls(rawCandidate).length > 0) {
                return this.buildToolSummaryFallback(toolResults);
            }
            const compact = candidate.trim();
            if (compact === "[]" || compact === "{}") {
                return this.buildToolSummaryFallback(toolResults);
            }
            if (candidate.length > 1200 || /```/.test(candidate)) {
                return this.buildToolSummaryFallback(toolResults);
            }
            return candidate;
        }
        catch {
            return this.buildToolSummaryFallback(toolResults);
        }
    }
    buildToolSummaryFallback(toolResults) {
        const mutationMatches = [...toolResults.matchAll(/(?:^|\n)(edit|write)\s+([^\n(]+)(?:\s|\(|$)/gi)];
        const mutatedPaths = [...new Set(mutationMatches.map((match) => (match[2] ?? "").trim()).filter((value) => value.length > 0))];
        if (mutatedPaths.length === 1) {
            return `Applied changes to ${mutatedPaths[0]}.`;
        }
        if (mutatedPaths.length > 1) {
            return `Applied changes to ${mutatedPaths.join(", ")}.`;
        }
        return "Applied actions, but the model did not return a clean final summary.";
    }
    inferDirectAnswerFromContext(userInput, contextItems) {
        const lower = userInput.toLowerCase();
        const asksFramework = (lower.includes("framework") || lower.includes("library") || lower.includes("stack")) &&
            (lower.includes("ui") || lower.includes("frontend") || lower.includes("tui") || lower.includes("project"));
        if (!asksFramework) {
            return null;
        }
        const packageLike = contextItems.filter((item) => item.path?.toLowerCase().endsWith("package.json") || item.path?.toLowerCase().includes("readme"));
        const merged = packageLike.map((item) => item.content.toLowerCase()).join("\n");
        const hasInk = /\bink\b/.test(merged);
        const hasReact = /\breact\b/.test(merged);
        if (hasInk && hasReact) {
            return "This projectâ€™s UI framework is Ink with React.";
        }
        if (hasReact) {
            return "This project uses React for UI.";
        }
        if (hasInk) {
            return "This project uses Ink for its terminal UI.";
        }
        return null;
    }
    buildRecoveryTaskSummary(task) {
        const summaryLines = [
            (task.objective ?? task.raw).replace(/\s+/g, " ").trim() || task.intent,
            task.entities.paths.length > 0 ? `Relevant paths: ${task.entities.paths.join(", ")}` : "",
            task.entities.symbols.length > 0 ? `Relevant symbols: ${task.entities.symbols.join(", ")}` : "",
            task.entities.errors.length > 0 ? `Observed errors: ${task.entities.errors.join(" | ")}` : "",
            task.entities.domains.length > 0 ? `Relevant domains: ${task.entities.domains.join(", ")}` : ""
        ].filter((line) => line.length > 0);
        return summaryLines.join("\n");
    }
    async filterSafeEditRecoveryCalls(calls) {
        const safeCalls = [];
        for (const call of calls) {
            if (call.tool === "read") {
                if (await this.isSafeRecoveryPath(call.path, "read")) {
                    safeCalls.push(call);
                }
                continue;
            }
            if ((call.tool === "edit" || call.tool === "write") && (await this.isSafeRecoveryPath(call.path, call.tool))) {
                safeCalls.push(call);
            }
        }
        return safeCalls;
    }
    async filterSafeMutationCalls(calls) {
        const safeCalls = [];
        for (const call of calls) {
            if ((call.tool === "edit" || call.tool === "write") && (await this.isSafeRecoveryPath(call.path, call.tool))) {
                safeCalls.push(call);
            }
        }
        return safeCalls;
    }
    async isSafeRecoveryPath(rawPath, tool) {
        const candidate = rawPath.trim();
        if (candidate.length === 0) {
            return false;
        }
        let absolutePath;
        try {
            absolutePath = this.resolveWorkspacePath(candidate);
        }
        catch {
            return false;
        }
        const relativePath = path.relative(this.config.paths.repoDir, absolutePath).replace(/\\/g, "/");
        if (this.isGeneratedRecoveryPath(relativePath)) {
            return false;
        }
        try {
            const fileStat = await stat(absolutePath);
            if (fileStat.isDirectory()) {
                return false;
            }
            return fileStat.isFile();
        }
        catch {
            if (tool !== "write") {
                return false;
            }
            try {
                const parentStat = await stat(path.dirname(absolutePath));
                return parentStat.isDirectory();
            }
            catch {
                return false;
            }
        }
    }
    isGeneratedRecoveryPath(relativePath) {
        const normalized = relativePath.replace(/\\/g, "/").replace(/\/+$/g, "");
        return this.config.repo.generatedPaths.some((candidate) => {
            const generated = candidate.replace(/\\/g, "/").replace(/\/+$/g, "");
            return normalized === generated || normalized.startsWith(`${generated}/`);
        });
    }
    resolveWorkspacePath(rawPath) {
        const repoRoot = path.resolve(this.config.paths.repoDir);
        const target = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(repoRoot, rawPath);
        const relative = path.relative(repoRoot, target);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(`Path outside workspace is not allowed: ${rawPath}`);
        }
        return target;
    }
    async executeToolCalls(calls) {
        return await executeToolCalls(this.config.paths.repoDir, calls);
    }
}
