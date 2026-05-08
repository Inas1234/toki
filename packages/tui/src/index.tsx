import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export interface TuiMessage {
  id: number;
  speaker: "you" | "toki";
  content: string;
  isError?: boolean;
}

export interface HeaderInfo {
  repo: string;
  provider: string;
  model: string;
  mode: string;
}

export interface SelectionOption {
  id: string;
  label: string;
  description?: string;
}

export const TOKI_THEME = {
  primary: "#7C3AED",
  accent: "#A855F7",
  muted: "#DDD6FE",
  bgDark: "#1E1030",
  text: "#E2E8F0"
} as const;

interface MarkdownSegment {
  kind: "text" | "code";
  language?: string;
  value: string;
}

interface InlineToken {
  kind: "text" | "bold" | "italic" | "code" | "link";
  value: string;
  href?: string;
}

export function sanitizeRenderableContent(content: string): string {
  return content
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/\[tool_calls?\][\s\S]*?\[\/tool_calls?\]/gi, "")
    .replace(/^\s*\{\s*"?tool"?\s*:\s*["']?.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseMarkdown(content: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const sanitizedContent = sanitizeRenderableContent(content);
  const lines = sanitizedContent.split(/\r?\n/);
  const textBuffer: string[] = [];
  let i = 0;

  const flushText = () => {
    if (textBuffer.length > 0) {
      segments.push({ kind: "text", value: textBuffer.join("\n") });
      textBuffer.length = 0;
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fenceStart = line.match(/^\s{0,3}```([a-zA-Z0-9_-]*)\s*$/);
    if (!fenceStart) {
      textBuffer.push(line);
      i += 1;
      continue;
    }

    flushText();
    const codeLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && !/^\s{0,3}```\s*$/.test(lines[j] ?? "")) {
      codeLines.push(lines[j] ?? "");
      j += 1;
    }

    if (j >= lines.length) {
      // Unclosed fence: treat as plain text.
      textBuffer.push(line, ...codeLines);
      break;
    }

    segments.push({
      kind: "code",
      language: fenceStart[1] && fenceStart[1].trim().length > 0 ? fenceStart[1].trim() : "code",
      value: codeLines.join("\n").trimEnd()
    });
    i = j + 1;
  }

  flushText();
  return segments.length > 0 ? segments : [{ kind: "text", value: sanitizedContent }];
}

export function parseMarkdownSegmentsForTest(content: string): { kind: "text" | "code"; language?: string; value: string }[] {
  return parseMarkdown(content);
}

function parseInlineMarkdown(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match = pattern.exec(line);

  while (match) {
    if (match.index > last) {
      tokens.push({ kind: "text", value: line.slice(last, match.index) });
    }

    const raw = match[0] ?? "";
    if ((raw.startsWith("**") && raw.endsWith("**")) || (raw.startsWith("__") && raw.endsWith("__"))) {
      tokens.push({ kind: "bold", value: raw.slice(2, -2) });
    } else if ((raw.startsWith("*") && raw.endsWith("*")) || (raw.startsWith("_") && raw.endsWith("_"))) {
      tokens.push({ kind: "italic", value: raw.slice(1, -1) });
    } else if (raw.startsWith("`") && raw.endsWith("`")) {
      tokens.push({ kind: "code", value: raw.slice(1, -1) });
    } else if (raw.startsWith("[") && raw.includes("](") && raw.endsWith(")")) {
      const linkMatch = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        tokens.push({ kind: "link", value: linkMatch[1] ?? "", href: linkMatch[2] ?? "" });
      } else {
        tokens.push({ kind: "text", value: raw });
      }
    } else {
      tokens.push({ kind: "text", value: raw });
    }

    last = match.index + raw.length;
    match = pattern.exec(line);
  }

  if (last < line.length) {
    tokens.push({ kind: "text", value: line.slice(last) });
  }
  return tokens.length > 0 ? tokens : [{ kind: "text", value: line }];
}

function renderInlineTokens(tokens: InlineToken[], keyPrefix: string, baseColor: string): React.ReactNode[] {
  return tokens.map((token, idx) => {
    const key = `${keyPrefix}-${idx}`;
    if (token.kind === "bold") {
      return (
        <Text key={key} bold color={baseColor}>
          {token.value}
        </Text>
      );
    }
    if (token.kind === "italic") {
      return (
        <Text key={key} italic color={baseColor}>
          {token.value}
        </Text>
      );
    }
    if (token.kind === "code") {
      return (
        <Text key={key} color={TOKI_THEME.muted} backgroundColor={TOKI_THEME.bgDark}>
          {` ${token.value} `}
        </Text>
      );
    }
    if (token.kind === "link") {
      return (
        <Text key={key}>
          <Text color={TOKI_THEME.accent} underline>
            {token.value}
          </Text>
          {token.href ? <Text color={TOKI_THEME.muted}>{` (${token.href})`}</Text> : null}
        </Text>
      );
    }
    return (
      <Text key={key} color={baseColor}>
        {token.value}
      </Text>
    );
  });
}

function renderMarkdownLine(line: string, key: string, baseColor: string): React.ReactNode {
  if (line.trim().length === 0) {
    return (
      <Text key={key} color={baseColor}>
        {" "}
      </Text>
    );
  }

  const action = line.match(/^\*\s+([A-Z_]+)\((.*)\)$/);
  if (action) {
    return (
      <Text key={key}>
        <Text color="#22D3EE" bold>
          {action[1] ?? "ACTION"}
        </Text>
        <Text color={TOKI_THEME.muted}>{`(${action[2] ?? ""})`}</Text>
      </Text>
    );
  }

  const actionResult = line.match(/^\s{2}L\s+([A-Z]+)\s(.*)$/);
  if (actionResult) {
    const tag = actionResult[1] ?? "";
    const tail = actionResult[2] ?? "";
    const tagColor = tag === "ERROR" ? "#F87171" : tag === "INFO" ? "#60A5FA" : "#34D399";
    return (
      <Text key={key}>
        <Text color={TOKI_THEME.muted}>  L </Text>
        <Text color={tagColor} bold>
          {tag}
        </Text>
        <Text color={TOKI_THEME.text}>{` ${tail}`}</Text>
      </Text>
    );
  }

  const diffHeader = line.match(/^\s{2}L\s+@@ diff @@$/);
  if (diffHeader) {
    return (
      <Text key={key} color={TOKI_THEME.muted}>
        {line}
      </Text>
    );
  }

  const diffAdded = line.match(/^\s{2}\+\s(.*)$/);
  if (diffAdded) {
    return (
      <Text key={key} color="#22C55E">
        {`  + ${diffAdded[1] ?? ""}`}
      </Text>
    );
  }

  const diffRemoved = line.match(/^\s{2}-\s(.*)$/);
  if (diffRemoved) {
    return (
      <Text key={key} color="#F59E0B">
        {`  - ${diffRemoved[1] ?? ""}`}
      </Text>
    );
  }

  const hr = line.match(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/);
  if (hr) {
    return (
      <Text key={key} color={TOKI_THEME.primary}>
        {"-".repeat(72)}
      </Text>
    );
  }

  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const level = heading[1]?.length ?? 1;
    const headingColor = level <= 2 ? TOKI_THEME.accent : TOKI_THEME.muted;
    return (
      <Text key={key} color={headingColor} bold>
        {heading[2] ?? ""}
      </Text>
    );
  }

  const quote = line.match(/^>\s?(.*)$/);
  if (quote) {
    return (
      <Text key={key} color={TOKI_THEME.muted}>
        <Text color={TOKI_THEME.primary}>| </Text>
        {renderInlineTokens(parseInlineMarkdown(quote[1] ?? ""), `${key}-quote`, TOKI_THEME.muted)}
      </Text>
    );
  }

  const task = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/);
  if (task) {
    const indent = Math.floor((task[1]?.length ?? 0) / 2);
    const checked = (task[2] ?? " ").toLowerCase() === "x";
    return (
      <Text key={key} color={baseColor}>
        {`${"  ".repeat(indent)}${checked ? "[x]" : "[ ]"} `}
        {renderInlineTokens(parseInlineMarkdown(task[3] ?? ""), `${key}-task`, baseColor)}
      </Text>
    );
  }

  const unordered = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (unordered) {
    const indent = Math.floor((unordered[1]?.length ?? 0) / 2);
    return (
      <Text key={key} color={baseColor}>
        {`${"  ".repeat(indent)}- `}
        {renderInlineTokens(parseInlineMarkdown(unordered[2] ?? ""), `${key}-ul`, baseColor)}
      </Text>
    );
  }

  const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (ordered) {
    const indent = Math.floor((ordered[1]?.length ?? 0) / 2);
    return (
      <Text key={key} color={baseColor}>
        {`${"  ".repeat(indent)}${ordered[2] ?? "1"}. `}
        {renderInlineTokens(parseInlineMarkdown(ordered[3] ?? ""), `${key}-ol`, baseColor)}
      </Text>
    );
  }

  return (
    <Text key={key} color={baseColor}>
      {renderInlineTokens(parseInlineMarkdown(line), `${key}-p`, baseColor)}
    </Text>
  );
}

function renderTextSegmentWithThinking(segmentValue: string, messageId: number, segmentIndex: number, baseColor: string): React.ReactNode[] {
  const lines = segmentValue.split(/\r?\n/);
  const nodes: React.ReactNode[] = [];
  let inThinkingBlock = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const thinking = line.match(/^~\s+(.*)$/);
    const keyBase = `${messageId}-t-${segmentIndex}-${i}`;

    if (thinking) {
      if (!inThinkingBlock) {
        nodes.push(
          <Text key={`${keyBase}-label`} color={TOKI_THEME.muted} dimColor>
            thinking
          </Text>
        );
        inThinkingBlock = true;
      }
      nodes.push(
        <Text key={`${keyBase}-item`} color={TOKI_THEME.muted} dimColor italic>
          {`  - ${thinking[1] ?? ""}`}
        </Text>
      );
      continue;
    }

    inThinkingBlock = false;
    nodes.push(renderMarkdownLine(line, keyBase, baseColor));
  }

  return nodes;
}

export function TokiHeader({ header, version = "0.1.0" }: { header: HeaderInfo; version?: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={TOKI_THEME.primary}>{`Toki CLI v${version}`}</Text>
      <Text color={TOKI_THEME.muted}>{`repo ${header.repo} | provider ${header.provider} | model ${header.model} | mode ${header.mode}`}</Text>
      <Text color={TOKI_THEME.primary}>{"-".repeat(86)}</Text>
    </Box>
  );
}

export function OnboardingPanel(props: { provider: string; hasAnyActivity: boolean }) {
  return (
    <Box borderStyle="single" borderColor={TOKI_THEME.primary} flexDirection="column" paddingX={1} marginBottom={1}>
      <Box marginBottom={1}>
        <Box flexDirection="column" width="34%" paddingRight={1}>
          <Text color={TOKI_THEME.muted}>Welcome to Toki</Text>
          <Text color={TOKI_THEME.accent}>Provider setup required</Text>
          <Text color={TOKI_THEME.text}> </Text>
          <Text color={TOKI_THEME.accent}>{"  [::]"}</Text>
          <Text color={TOKI_THEME.accent}>{" [::::]"}</Text>
          <Text color={TOKI_THEME.accent}>{"  [::]"}</Text>
          <Text color={TOKI_THEME.text}>current provider: {props.provider}</Text>
          <Text color={TOKI_THEME.text}>status: {props.hasAnyActivity ? "resume" : "new session"}</Text>
        </Box>
        <Box borderLeft paddingLeft={1} borderColor={TOKI_THEME.primary} flexDirection="column" width="66%">
          <Text color={TOKI_THEME.accent}>Tips to get started</Text>
          <Text color={TOKI_THEME.text}>1. Select provider in popup (or run /provider)</Text>
          <Text color={TOKI_THEME.text}>2. Enter API key when prompted</Text>
          <Text color={TOKI_THEME.text}>3. Pick a model (or run /model)</Text>
          <Text color={TOKI_THEME.text}>4. Start with a coding task</Text>
          <Text color={TOKI_THEME.primary}>{"-".repeat(52)}</Text>
          <Text color={TOKI_THEME.accent}>Recent activity</Text>
          <Text color={TOKI_THEME.text}>{props.hasAnyActivity ? "Session history available" : "No recent activity"}</Text>
        </Box>
      </Box>
      <Text color={TOKI_THEME.primary}>{"-".repeat(86)}</Text>
      <Text color={TOKI_THEME.muted}>Onboarding is active until provider credentials are saved.</Text>
    </Box>
  );
}

export function ThinkingIndicator({ label = "thinking" }: { label?: string }) {
  return (
    <Text color={TOKI_THEME.muted}>
      <Text color={TOKI_THEME.accent}>
        <Spinner type="dots" />
      </Text>{" "}
      {label}
    </Text>
  );
}

export function MessageFeed({ messages }: { messages: TuiMessage[] }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}
    </Box>
  );
}

function MessageRow({ message }: { message: TuiMessage }) {
  const prefixColor = message.speaker === "you" ? TOKI_THEME.muted : message.isError ? "#ff6b6b" : TOKI_THEME.accent;
  const contentColor = message.isError ? "#ff6b6b" : TOKI_THEME.text;
  const segments = parseMarkdown(message.content);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={prefixColor}>{`${message.speaker}> `}</Text>
      {segments.map((segment, index) =>
        segment.kind === "code" ? (
          <Box key={`${message.id}-code-${index}`} borderStyle="round" borderColor={TOKI_THEME.primary} paddingX={1} flexDirection="column">
            <Text color={TOKI_THEME.primary}>{segment.language ?? "code"}</Text>
            {segment.value.split(/\r?\n/).map((line, i) => (
              <Text key={`${message.id}-c-${index}-${i}`} color={TOKI_THEME.muted}>
                {line}
              </Text>
            ))}
          </Box>
        ) : (
          <Box key={`${message.id}-text-${index}`} flexDirection="column">
            {renderTextSegmentWithThinking(segment.value, message.id, index, contentColor)}
          </Box>
        )
      )}
    </Box>
  );
}

export function ContextFooter({ text }: { text: string }) {
  return <Text color={TOKI_THEME.muted}>{text}</Text>;
}

export function SelectionPopup(props: {
  title: string;
  options: SelectionOption[];
  selectedIndex: number;
  hint?: string;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={TOKI_THEME.primary} paddingX={1} marginBottom={1}>
      <Text color={TOKI_THEME.accent}>{props.title}</Text>
      {props.options.map((option, idx) => (
        <Text key={option.id} color={idx === props.selectedIndex ? TOKI_THEME.muted : TOKI_THEME.text}>
          {idx === props.selectedIndex ? ">" : " "} {option.label}
          {option.description ? `  (${option.description})` : ""}
        </Text>
      ))}
      <Text color={TOKI_THEME.muted}>{props.hint ?? "Use up/down arrows, Enter to select, Esc to cancel"}</Text>
    </Box>
  );
}

export function SlashAutocomplete(props: { options: SelectionOption[]; selectedIndex: number }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={TOKI_THEME.primary} paddingX={1} marginBottom={1}>
      {props.options.map((option, idx) => (
        <Text key={option.id} color={idx === props.selectedIndex ? TOKI_THEME.muted : TOKI_THEME.text}>
          {idx === props.selectedIndex ? ">" : " "} /{option.id}  {option.description ?? ""}
        </Text>
      ))}
      <Text color={TOKI_THEME.muted}>Tab to autocomplete</Text>
    </Box>
  );
}
