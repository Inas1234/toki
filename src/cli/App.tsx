import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  ContextFooter,
  MessageFeed,
  OnboardingPanel,
  SelectionOption,
  SelectionPopup,
  SlashAutocomplete,
  ThinkingIndicator,
  TOKI_THEME,
  TokiHeader,
  TuiMessage
} from "@toki/tui";
import { TokiEngine } from "@toki/coding-agent";
import { buildBuiltinCommands } from "../commands/builtins.js";
import { CommandContext, SecretPrompt, SelectionPrompt } from "../commands/types.js";
import { CommandRegistry } from "../commands/registry.js";

interface AppProps {
  engine: TokiEngine;
}

function fuzzyScore(candidateRaw: string, queryRaw: string): number | null {
  const candidate = candidateRaw.toLowerCase();
  const query = queryRaw.toLowerCase().trim();
  if (query.length === 0) {
    return 0;
  }

  const exactIndex = candidate.indexOf(query);
  if (exactIndex >= 0) {
    const prefixBonus = exactIndex === 0 ? 120 : 0;
    return 1_000 + prefixBonus - exactIndex;
  }

  let lastIndex = -1;
  let firstMatch = -1;
  let contiguous = 0;
  let boundaryHits = 0;

  for (const char of query) {
    const nextIndex = candidate.indexOf(char, lastIndex + 1);
    if (nextIndex === -1) {
      return null;
    }
    if (firstMatch === -1) {
      firstMatch = nextIndex;
    }
    if (lastIndex >= 0 && nextIndex === lastIndex + 1) {
      contiguous += 1;
    }
    const prev = nextIndex > 0 ? candidate[nextIndex - 1] : "";
    if (nextIndex === 0 || prev === "/" || prev === "-" || prev === "_" || prev === "." || prev === " ") {
      boundaryHits += 1;
    }
    lastIndex = nextIndex;
  }

  const span = lastIndex - firstMatch + 1;
  const compactnessPenalty = Math.max(0, span - query.length);
  return query.length * 30 + contiguous * 10 + boundaryHits * 12 - firstMatch * 0.5 - compactnessPenalty * 2;
}

export function App({ engine }: AppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [inputResetVersion, setInputResetVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [messages, setMessages] = useState<TuiMessage[]>([]);
  const [messageId, setMessageId] = useState(0);
  const [contextLine, setContextLine] = useState("");
  const [header, setHeader] = useState(engine.getHeaderInfo());
  const [secretPrompt, setSecretPrompt] = useState<SecretPrompt | null>(null);
  const [selectionPrompt, setSelectionPrompt] = useState<SelectionPrompt | null>(null);
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [selectionQuery, setSelectionQuery] = useState("");
  const [commandSuggestionIndex, setCommandSuggestionIndex] = useState(0);
  const [onboardingActive, setOnboardingActive] = useState(engine.providerNeedsCredentials(engine.getCurrentProvider()));
  const [onboardingStarted, setOnboardingStarted] = useState(false);

  function replaceInput(nextValue: string): void {
    setInput(nextValue);
    setInputResetVersion((value) => value + 1);
  }

  const commandContext: CommandContext = useMemo(
    () => ({
      getReceipt: () => engine.getLedger().current(),
      explainPath: (value: string) => engine.getLedger().explainPath(value),
      pin: (value: string) => engine.getBroker().pin(value),
      drop: (value: string) => engine.getBroker().drop(value),
      clearConversation: () => {
        engine.clearConversation();
        setMessages([]);
      },
      getBudgetSummary: () => engine.getBudgetSummary(),
      setMode: (mode) => {
        engine.getBroker().setMode(mode);
        setHeader(engine.getHeaderInfo());
      },
      getMode: () => engine.getBroker().getMode(),
      getCurrentModel: () => engine.getCurrentModel(),
      setModel: async (value: string) => {
        await engine.setModel(value);
        setHeader(engine.getHeaderInfo());
      },
      listModels: () => engine.listModels(),
      getCurrentProvider: () => engine.getCurrentProvider(),
      listProviders: () => engine.listProviders(),
      switchProvider: async (providerId: string) => {
        await engine.switchProvider(providerId);
        setHeader(engine.getHeaderInfo());
      },
      exit: () => exit(),
      providerNeedsCredentials: (providerId: string) => engine.providerNeedsCredentials(providerId),
      getProviderRequirements: (providerId: string) => engine.getProviderRequirements(providerId),
      setProviderCredential: async (providerId: string, fieldKey: string, value: string) => {
        await engine.setProviderCredential(providerId, fieldKey, value);
      }
    }),
    [engine]
  );

  const registry = useMemo(() => {
    let reg: CommandRegistry;
    const handlers = buildBuiltinCommands(() => reg.listHandlers());
    reg = new CommandRegistry(handlers);
    return reg;
  }, []);

  const allCommands = useMemo(() => registry.listHandlers(), [registry]);

  const filteredSelectionOptions = useMemo(() => {
    if (!selectionPrompt) {
      return [];
    }
    if (selectionPrompt.kind !== "model") {
      return selectionPrompt.options;
    }
    const query = selectionQuery.trim().toLowerCase();
    if (query.length === 0) {
      return selectionPrompt.options;
    }
    const ranked = selectionPrompt.options
      .map((option) => {
        const idScore = fuzzyScore(option.id, query);
        const labelScore = fuzzyScore(option.label, query);
        const descriptionScore = option.description ? fuzzyScore(option.description, query) : null;
        const score = Math.max(idScore ?? Number.NEGATIVE_INFINITY, labelScore ?? Number.NEGATIVE_INFINITY);
        const finalScore = descriptionScore !== null ? Math.max(score, descriptionScore - 8) : score;
        if (!Number.isFinite(finalScore)) {
          return null;
        }
        return { option, score: finalScore };
      })
      .filter((item): item is { option: SelectionOption; score: number } => item !== null)
      .sort((left, right) => right.score - left.score || left.option.id.localeCompare(right.option.id));
    return ranked.map((item) => item.option);
  }, [selectionPrompt, selectionQuery]);

  const visibleSelectionState = useMemo(() => {
    const options = filteredSelectionOptions;
    const pageSize = 12;
    if (options.length <= pageSize) {
      return {
        options,
        selectedInView: selectionIndex,
        start: 0,
        end: options.length
      };
    }
    const half = Math.floor(pageSize / 2);
    const maxStart = options.length - pageSize;
    const start = Math.max(0, Math.min(maxStart, selectionIndex - half));
    const end = start + pageSize;
    return {
      options: options.slice(start, end),
      selectedInView: selectionIndex - start,
      start,
      end
    };
  }, [filteredSelectionOptions, selectionIndex]);

  const commandSuggestions = useMemo(() => {
    if (busy || selectionPrompt || secretPrompt) {
      return [];
    }
    if (!input.startsWith("/")) {
      return [];
    }
    const fragment = input.slice(1);
    if (fragment.includes(" ")) {
      return [];
    }
    const query = fragment.toLowerCase();
    return allCommands
      .filter((command) => command.name.toLowerCase().startsWith(query))
      .slice(0, 8)
      .map((command) => ({ id: command.name, label: command.name, description: command.description }));
  }, [allCommands, busy, input, secretPrompt, selectionPrompt]);

  useEffect(() => {
    setCommandSuggestionIndex(0);
  }, [input, secretPrompt, selectionPrompt]);

  useEffect(() => {
    if (!selectionPrompt) {
      setSelectionQuery("");
      setSelectionIndex(0);
      return;
    }
    setSelectionIndex((idx) => {
      if (filteredSelectionOptions.length === 0) {
        return 0;
      }
      return Math.min(idx, filteredSelectionOptions.length - 1);
    });
  }, [filteredSelectionOptions.length, selectionPrompt]);

  useEffect(() => {
    if (!onboardingActive || onboardingStarted || selectionPrompt || secretPrompt) {
      return;
    }
    const options = commandContext.listProviders().map((provider) => ({
      id: provider.id,
      label: provider.name,
      description: provider.configured ? "configured" : "missing credentials"
    }));
    setSelectionPrompt({
      kind: "provider",
      title: "Select Provider",
      options
    });
    setSelectionIndex(0);
    setOnboardingStarted(true);
  }, [commandContext, onboardingActive, onboardingStarted, secretPrompt, selectionPrompt]);

  function buildSecretPromptForProvider(providerId: string): SecretPrompt | null {
    const req = commandContext.getProviderRequirements(providerId)[0];
    if (!req) {
      return null;
    }
    return {
      providerId,
      fieldKey: req.key,
      label: `${providerId} ${req.label}>`,
      ...(req.masked ? { masked: true } : {})
    };
  }

  async function switchProviderAndMaybePromptCredential(providerId: string, forceCredentialPrompt = false): Promise<void> {
    await commandContext.switchProvider(providerId);
    setHeader(engine.getHeaderInfo());
    const nextId = messageId + 1;
    setMessageId(nextId);
    setMessages((prev) => [...prev, { id: nextId, speaker: "toki", content: `Provider switched to ${providerId}.` }]);
    if (forceCredentialPrompt || commandContext.providerNeedsCredentials(providerId)) {
      const promptSecret = buildSecretPromptForProvider(providerId);
      if (promptSecret) {
        setSecretPrompt(promptSecret);
        setOnboardingActive(true);
      }
      return;
    }
    setOnboardingActive(false);
  }

  async function applySelection(prompt: SelectionPrompt, optionId: string): Promise<void> {
    if (prompt.kind === "provider") {
      await switchProviderAndMaybePromptCredential(optionId);
      return;
    }

    await commandContext.setModel(optionId);
    setHeader(engine.getHeaderInfo());
    const nextId = messageId + 1;
    setMessageId(nextId);
    setMessages((prev) => [...prev, { id: nextId, speaker: "toki", content: `Model switched to ${optionId}.` }]);
  }

  useInput((inputKey, key) => {
    if (busy) {
      return;
    }

    if (!selectionPrompt && !secretPrompt && commandSuggestions.length > 0) {
      if (key.tab || inputKey === "\t") {
        const pick = commandSuggestions[commandSuggestionIndex] ?? commandSuggestions[0];
        if (pick) {
          const completed = `/${pick.id}`;
          replaceInput(completed);
          setCommandSuggestionIndex((idx) => (idx + 1) % commandSuggestions.length);
        }
        return;
      }
    }

    if (!selectionPrompt) {
      return;
    }

    if (selectionPrompt.kind === "model") {
      if (key.backspace || key.delete) {
        setSelectionQuery((prev) => prev.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && !key.return && !key.upArrow && !key.downArrow && !key.escape && inputKey.length === 1) {
        setSelectionQuery((prev) => prev + inputKey);
        return;
      }
    }

    if (
      selectionPrompt.kind === "provider" &&
      !key.ctrl &&
      !key.meta &&
      inputKey.length === 1 &&
      inputKey.toLowerCase() === "k"
    ) {
      const selected = filteredSelectionOptions[selectionIndex];
      if (!selected) {
        return;
      }
      setSelectionPrompt(null);
      setSelectionQuery("");
      setSelectionIndex(0);
      void switchProviderAndMaybePromptCredential(selected.id, true).catch((error) => {
        const nextId = messageId + 1;
        setMessageId(nextId);
        setMessages((prev) => [
          ...prev,
          { id: nextId, speaker: "toki", content: error instanceof Error ? error.message : "Failed to update provider.", isError: true }
        ]);
      });
      return;
    }

    if (key.upArrow) {
      setSelectionIndex((idx) =>
        filteredSelectionOptions.length === 0 ? 0 : (idx - 1 + filteredSelectionOptions.length) % filteredSelectionOptions.length
      );
      return;
    }

    if (key.downArrow) {
      setSelectionIndex((idx) =>
        filteredSelectionOptions.length === 0 ? 0 : (idx + 1) % filteredSelectionOptions.length
      );
      return;
    }

    if (key.return) {
      const selected = filteredSelectionOptions[selectionIndex];
      if (!selected) return;
      setSelectionPrompt(null);
      setSelectionQuery("");
      setSelectionIndex(0);
      void applySelection(selectionPrompt, selected.id).catch((error) => {
        const nextId = messageId + 1;
        setMessageId(nextId);
        setMessages((prev) => [
          ...prev,
          { id: nextId, speaker: "toki", content: error instanceof Error ? error.message : "Selection failed.", isError: true }
        ]);
      });
      return;
    }

    if (key.escape) {
      setSelectionPrompt(null);
      setSelectionQuery("");
      setSelectionIndex(0);
      const nextId = messageId + 1;
      setMessageId(nextId);
      setMessages((prev) => [...prev, { id: nextId, speaker: "toki", content: "Selection cancelled." }]);
    }
  });

  async function onSubmit(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed || busy || selectionPrompt) {
      return;
    }

    if (secretPrompt) {
      try {
        await commandContext.setProviderCredential(secretPrompt.providerId, secretPrompt.fieldKey, trimmed);
        setSecretPrompt(null);
        setHeader(engine.getHeaderInfo());
        setOnboardingActive(false);
        const nextId = messageId + 1;
        setMessageId(nextId);
        setMessages((prev) => [...prev, { id: nextId, speaker: "toki", content: "Credential saved. Provider ready." }]);
      } catch (error) {
        const nextId = messageId + 1;
        setMessageId(nextId);
        setMessages((prev) => [
          ...prev,
          {
            id: nextId,
            speaker: "toki",
            content: error instanceof Error ? error.message : "Failed to save credential.",
            isError: true
          }
        ]);
      }
      replaceInput("");
      return;
    }

    if (trimmed === "exit" || trimmed === "quit" || trimmed === "/quit") {
      exit();
      return;
    }

    replaceInput("");
    const nextId = messageId + 1;
    setMessageId(nextId);
    setMessages((prev) => [...prev, { id: nextId, speaker: "you", content: trimmed }]);

    const command = await registry.execute(trimmed, commandContext);
    if (command.handled) {
      const cmdId = nextId + 1;
      setMessageId(cmdId);
      setMessages((prev) => [
        ...prev,
        command.error
          ? { id: cmdId, speaker: "toki", content: command.output, isError: true }
          : { id: cmdId, speaker: "toki", content: command.output }
      ]);
      if (command.promptForSecret) {
        setSecretPrompt(command.promptForSecret);
      }
      if (command.promptForSelection) {
        setSelectionPrompt(command.promptForSelection);
        setSelectionIndex(0);
      }
      return;
    }

    setBusy(true);
    setThinking(true);
    const assistantId = nextId + 1;
    setMessageId(assistantId);
    setMessages((prev) => [...prev, { id: assistantId, speaker: "toki", content: "" }]);

    try {
      const result = await engine.runTurn(trimmed, (chunk) => {
        setThinking(false);
        setMessages((prev) => prev.map((msg) => (msg.id === assistantId ? { ...msg, content: `${msg.content}${chunk}` } : msg)));
      });
      setContextLine(result.contextLine);
      setHeader(engine.getHeaderInfo());
    } catch (error) {
      setThinking(false);
      const message = error instanceof Error ? error.message : "Unknown error";
      setMessages((prev) =>
        prev.map((msg) => (msg.id === assistantId ? { id: msg.id, speaker: msg.speaker, content: message, isError: true } : msg))
      );
    } finally {
      setBusy(false);
      setThinking(false);
    }
  }

  return (
    <Box flexDirection="column">
      <TokiHeader header={header} />

      {onboardingActive ? <OnboardingPanel provider={header.provider} hasAnyActivity={messages.length > 0} /> : null}

      <MessageFeed messages={messages} />

      {thinking ? <ThinkingIndicator label="toki is thinking" /> : null}
      {contextLine ? <ContextFooter text={contextLine} /> : null}

      {selectionPrompt ? (
        <SelectionPopup
          title={
            selectionPrompt.kind === "model"
              ? `${selectionPrompt.title} | filter: ${selectionQuery || "(none)"} | ${filteredSelectionOptions.length} shown`
              : selectionPrompt.title
          }
          options={visibleSelectionState.options as SelectionOption[]}
          selectedIndex={visibleSelectionState.selectedInView}
          hint={
            selectionPrompt.kind === "model"
              ? `Type to filter, Backspace to delete, arrows to navigate, Enter to select, Esc to cancel${
                  filteredSelectionOptions.length > visibleSelectionState.options.length
                    ? ` (${visibleSelectionState.start + 1}-${visibleSelectionState.end} of ${filteredSelectionOptions.length})`
                    : ""
                }`
              : "Use arrows, Enter to select provider, K to change API key, Esc to cancel"
          }
        />
      ) : null}

      {!selectionPrompt && !secretPrompt && commandSuggestions.length > 0 ? (
        <SlashAutocomplete options={commandSuggestions as SelectionOption[]} selectedIndex={commandSuggestionIndex} />
      ) : null}

      <Box flexDirection="column">
        {secretPrompt ? <Text color={TOKI_THEME.muted}>{secretPrompt.label}</Text> : null}
        <Box
          borderStyle="single"
          borderColor={TOKI_THEME.primary}
          paddingX={1}
          width="100%"
          minHeight={3}
          justifyContent="flex-start"
        >
          <Text color={TOKI_THEME.accent}>› </Text>
          <TextInput
            key={inputResetVersion}
            value={input}
            placeholder={secretPrompt ? "Enter credential..." : 'Try "refactor <filepath>"'}
            onChange={setInput}
            onSubmit={(submitted) => void onSubmit(submitted)}
            focus={!busy && !selectionPrompt}
            {...(secretPrompt?.masked ? { mask: "*" } : {})}
          />
        </Box>
      </Box>
      <Text color={TOKI_THEME.muted}>? for shortcuts</Text>
    </Box>
  );
}
