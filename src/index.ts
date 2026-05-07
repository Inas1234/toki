#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { App } from "./cli/App.js";
import { TokiEngine } from "./core/engine.js";

async function run(): Promise<void> {
  const program = new Command();
  program
    .name("toki")
    .description("Minimal, context-efficient CLI coding agent")
    .option("-m, --model <model>", "Override model for this session")
    .option("--mode <mode>", "Context mode: auto|tiny|normal|deep")
    .parse(process.argv);

  const options = program.opts<{ model?: string; mode?: "auto" | "tiny" | "normal" | "deep" }>();
  const cwd = process.cwd();
  const engine = new TokiEngine();
  await engine.initialize({ cwd });

  if (options.model) {
    await engine.setModel(options.model);
  }
  if (options.mode) {
    engine.getBroker().setMode(options.mode);
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
