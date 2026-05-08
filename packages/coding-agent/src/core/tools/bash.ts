import { exec as execCallback } from "node:child_process";
import type { ToolCallByName, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { summarizeInline, truncateText } from "./helpers.js";

const MAX_COMMAND_BUFFER_BYTES = 4 * 1024 * 1024;
const COMMAND_PREVIEW_MAX_CHARS = 4000;
const COMMAND_REPORT_MAX_CHARS = 12000;
const COMMAND_PREVIEW_MAX_LINES = 40;

export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    timeoutMs: number | undefined
  ) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;
}

const defaultOperations: BashOperations = {
  exec: async (command, cwd, timeoutMs) =>
    await new Promise((resolve) => {
      execCallback(
        command,
        {
          cwd,
          timeout: timeoutMs ?? 0,
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
    })
};

export interface BashToolOptions {
  operations?: BashOperations;
}

function renderCommandOutput(label: string, value: string, maxChars: number): string[] {
  const truncated = truncateText(value, maxChars);
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

function truncateForReport(value: string): string {
  const trimmed = truncateText(value, COMMAND_REPORT_MAX_CHARS);
  return trimmed.length > 0 ? trimmed : "(empty)";
}

export function createBashToolDefinition(cwd: string, options?: BashToolOptions): ToolDefinition<ToolCallByName<"bash">> {
  const ops = options?.operations ?? defaultOperations;
  return {
    name: "bash",
    description: "Execute a shell command in the current working directory.",
    promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
    async execute(call: ToolCallByName<"bash">, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
      const timeoutMs = typeof call.timeout === "number" ? Math.max(1, Math.floor(call.timeout * 1000)) : undefined;
      const result = await ops.exec(call.command, cwd, timeoutMs);
      const displayLines = [`  L EXIT ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`];
      if (result.stdout.length > 0) {
        displayLines.push(...renderCommandOutput("STDOUT", result.stdout, COMMAND_PREVIEW_MAX_CHARS));
      }
      if (result.stderr.length > 0) {
        displayLines.push(...renderCommandOutput("STDERR", result.stderr, COMMAND_PREVIEW_MAX_CHARS));
      }

      return {
        action: `BASH(${JSON.stringify(summarizeInline(call.command, 72))})`,
        displayLines,
        report: [
          `bash cwd=${cwd}${timeoutMs ? ` timeout_ms=${timeoutMs}` : ""} exit_code=${result.exitCode}${result.timedOut ? " timed_out=true" : ""}`,
          `command: ${call.command}`,
          "stdout:",
          truncateForReport(result.stdout),
          "stderr:",
          truncateForReport(result.stderr)
        ].join("\n"),
        mutationSuccessCount: 0
      };
    }
  };
}

export function createBashTool(cwd: string, options?: BashToolOptions): ToolDefinition<ToolCallByName<"bash">> {
  return createBashToolDefinition(cwd, options);
}
