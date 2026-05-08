#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { TokiEngine } from "@toki/coding-agent";
import { App } from "./cli/App.js";

async function readPromptFromStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }
  return chunks.join("").trim();
}

async function runBatchPrompt(engine: TokiEngine, prompt: string): Promise<void> {
  const result = await engine.runTurn(prompt, (chunk: string) => {
    process.stdout.write(chunk);
  });
  process.stdout.write(`\n${result.contextLine}\n`);
}

async function run(): Promise<void> {
  const program = new Command();
  program
    .name("toki")
    .description("Minimal, context-efficient CLI coding agent")
    .argument("[prompt...]", "Run a single prompt without starting the TUI")
    .option("-m, --model <model>", "Override model for this session")
    .option("--mode <mode>", "Context mode: auto|tiny|normal|deep")
    .parse(process.argv);

  const options = program.opts<{ model?: string; mode?: "auto" | "tiny" | "normal" | "deep" }>();
  const promptArgs = program.args;
  const cwd = process.cwd();
  const engine = new TokiEngine();
  await engine.initialize({ cwd });

  if (options.model) {
    await engine.setModel(options.model);
  }
  if (options.mode) {
    engine.getBroker().setMode(options.mode);
  }

  const promptFromArgs = promptArgs.join(" ").trim();
  if (promptFromArgs.length > 0) {
    await runBatchPrompt(engine, promptFromArgs);
    return;
  }

  if (!process.stdin.isTTY) {
    const promptFromStdin = await readPromptFromStdin();
    if (promptFromStdin.length > 0) {
      await runBatchPrompt(engine, promptFromStdin);
      return;
    }
  }

  render(React.createElement(App, { engine }), {
    patchConsole: false,
    exitOnCtrlC: true
  });
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`toki error: ${message}\n`);
  process.exitCode = 1;
});
