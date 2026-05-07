import { CommandContext, CommandHandler, CommandResult } from "./types.js";

function box(title: string, lines: string[]): string {
  const width = Math.max(title.length + 4, ...lines.map((line) => line.length + 2), 30);
  const top = `+-- ${title} ${"-".repeat(Math.max(1, width - title.length - 5))}+`;
  const body = lines.map((line) => `| ${line.padEnd(width - 2, " ")}|`).join("\n");
  const bottom = `+${"-".repeat(width)}+`;
  return `${top}\n${body}\n${bottom}`;
}

async function receiptCommand(context: CommandContext): Promise<CommandResult> {
  const receipt = context.getReceipt();
  if (!receipt) {
    return { handled: true, output: box("Receipt", ["No receipt available yet."]) };
  }
  const loaded = receipt.loaded.map(
    (item) => `loaded ${item.path ?? item.source} as ${item.representation} (${item.estimatedTokens}t) - ${item.reason}`
  );
  const skipped = receipt.skipped.map((item) => `skipped ${item.path} (${item.estimatedTokens}t) - ${item.reason}`);
  const compressed = receipt.compressed.map(
    (item) => `compressed ${item.source}: ${item.fromTokens}t -> ${item.toTokens}t via ${item.method}`
  );
  const lines = [
    `turn: ${receipt.turn}`,
    `mode: ${receipt.mode}`,
    `used: ${receipt.usedTokens} / ${receipt.ceiling}`,
    `saved: ~${receipt.savedTokens}`,
    `loaded: ${receipt.loaded.length}`,
    `skipped: ${receipt.skipped.length}`,
    `compressed: ${receipt.compressed.length}`,
    "",
    ...loaded,
    ...(skipped.length > 0 ? ["", ...skipped] : []),
    ...(compressed.length > 0 ? ["", ...compressed] : [])
  ];
  return { handled: true, output: box("Receipt", lines) };
}

export function buildBuiltinCommands(getAllHandlers: () => CommandHandler[]): CommandHandler[] {
  const openModelSelection = async (args: string, context: CommandContext): Promise<CommandResult> => {
    const trimmed = args.trim();
    if (!trimmed) {
      const models = await context.listModels();
      return {
        handled: true,
        output: box("Models", ["Use arrows to select, Enter to confirm, Esc to cancel."]),
        promptForSelection: {
          kind: "model",
          title: `Select Model (current: ${context.getCurrentModel()})`,
          options: models.map((model) => ({
            id: model.id,
            label: model.label,
            description: model.id
          }))
        }
      };
    }
    await context.setModel(trimmed);
    return { handled: true, output: box("Model", [`switched to: ${trimmed}`]) };
  };

  const handlers: CommandHandler[] = [
    {
      name: "receipt",
      description: "Show full context receipt for current turn",
      usage: "/receipt",
      run: async (_args, context) => receiptCommand(context)
    },
    {
      name: "why",
      description: "Explain why a file was loaded or skipped",
      usage: "/why <path>",
      run: async (args, context) => {
        if (!args.trim()) {
          return { handled: true, output: "Usage: /why <path>", error: true };
        }
        return {
          handled: true,
          output: box("Why", [context.explainPath(args.trim().replace(/\\/g, "/"))])
        };
      }
    },
    {
      name: "budget",
      description: "Show current token usage and ceiling",
      usage: "/budget",
      run: async (_args, context) => {
        const summary = context.getBudgetSummary();
        return {
          handled: true,
          output: box("Budget", [`mode: ${summary.mode}`, `used: ${summary.used}`, `ceiling: ${summary.ceiling}`])
        };
      }
    },
    {
      name: "pin",
      description: "Pin a file so it is always included",
      usage: "/pin <path>",
      run: async (args, context) => {
        if (!args.trim()) return { handled: true, output: "Usage: /pin <path>", error: true };
        context.pin(args.trim());
        return { handled: true, output: box("Pin", [`pinned: ${args.trim()}`]) };
      }
    },
    {
      name: "drop",
      description: "Remove a file from context",
      usage: "/drop <path>",
      run: async (args, context) => {
        if (!args.trim()) return { handled: true, output: "Usage: /drop <path>", error: true };
        context.drop(args.trim());
        return { handled: true, output: box("Drop", [`dropped: ${args.trim()}`]) };
      }
    },
    {
      name: "provider",
      description: "List providers and switch; prompts for required credentials",
      usage: "/provider [provider-id]",
      run: async (args, context) => {
        const trimmed = args.trim();
        if (!trimmed) {
          const providers = context.listProviders();
          return {
            handled: true,
            output: box("Providers", ["Use arrows to select, Enter to confirm, K to change API key, Esc to cancel."]),
            promptForSelection: {
              kind: "provider",
              title: `Select Provider (current: ${context.getCurrentProvider()})`,
              options: providers.map((provider) => ({
                id: provider.id,
                label: provider.name,
                description: provider.configured ? "configured" : "missing credentials"
              }))
            }
          };
        }
        await context.switchProvider(trimmed);
        if (context.providerNeedsCredentials(trimmed)) {
          const req = context.getProviderRequirements(trimmed)[0];
          if (!req) {
            return { handled: true, output: box("Provider", [`switched to ${trimmed}`]) };
          }
          return {
            handled: true,
            output: box("Provider", [`switched to ${trimmed}`, `credential required: ${req.label}`]),
            promptForSecret: {
              providerId: trimmed,
              fieldKey: req.key,
              label: `${trimmed} ${req.label}>`,
              masked: req.masked
            }
          };
        }
        return { handled: true, output: box("Provider", [`switched to: ${trimmed}`]) };
      }
    },
    {
      name: "model",
      description: "List available models and switch",
      usage: "/model [model-id]",
      run: async (args, context) => openModelSelection(args, context)
    },
    {
      name: "models",
      description: "Alias for /model",
      usage: "/models [model-id]",
      run: async (args, context) => openModelSelection(args, context)
    },
    {
      name: "tiny",
      description: "Switch to tiny context mode",
      usage: "/tiny",
      run: async (_args, context) => {
        context.setMode("tiny");
        return { handled: true, output: box("Mode", ["mode: tiny"]) };
      }
    },
    {
      name: "deep",
      description: "Switch to deep context mode",
      usage: "/deep",
      run: async (_args, context) => {
        context.setMode("deep");
        return { handled: true, output: box("Mode", ["mode: deep"]) };
      }
    },
    {
      name: "auto",
      description: "Switch back to auto mode",
      usage: "/auto",
      run: async (_args, context) => {
        context.setMode("auto");
        return { handled: true, output: box("Mode", ["mode: auto"]) };
      }
    },
    {
      name: "clear",
      description: "Clear current conversation context",
      usage: "/clear",
      run: async (_args, context) => {
        context.clearConversation();
        return { handled: true, output: box("Context", ["conversation cleared"]) };
      }
    },
    {
      name: "exit",
      description: "Exit Toki",
      usage: "/exit",
      run: async (_args, context) => {
        context.exit();
        return { handled: true, output: "Exiting..." };
      }
    },
    {
      name: "help",
      description: "List all commands",
      usage: "/help",
      run: async (_args) => {
        const rows = getAllHandlers().map((handler) => `${handler.usage.padEnd(22, " ")} ${handler.description}`);
        return { handled: true, output: box("Commands", rows) };
      }
    }
  ];
  return handlers;
}
