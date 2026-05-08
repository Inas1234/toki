# Toki

A minimal, extensible CLI coding agent focused on automatic context efficiency.

> ⚠️ **Status**: Project is in early development. Core features are being actively built.

## Features
- **Monorepo architecture**: Reusable packages for agent core, coding agent, providers, and shared utilities.
- **Context‑aware**: Uses a graph‑based context broker to select the most relevant files.
- **Pluggable providers**: Supports multiple LLM providers (Nim, OpenRouter, MiniMax, Scripted for testing) via a unified interface.
- **Task framing**: Detects intent, risk, and required edits/tests from natural‑language commands.
- **Compression**: Smart history compression to stay within token limits.
- **TUI**: Interactive terminal UI built with Ink/React.
- **Edit recovery**: Monitors edit progress, detects exploration stalls, and escalates to automatic recovery when needed.
- **Tool abstractions**: Unified tool call system with JSON-RPC style invocation for extensibility.

## Getting Started
```bash
# Install dependencies
npm install

# Run the CLI in development mode
npm run dev
```

This will automatically build all packages and start the CLI using tsx.



## Usage
```bash
# Run a command
node dist/index.js <your-prompt>
```

The CLI will:
1. Parse your prompt into a **TaskFrame** (intent, risk, edit/test flags).
2. Select relevant context files via **ContextBroker**.
3. Build a prompt with **PromptBuilder** and send it to the configured model.
4. Apply edits or run tests based on the model's response.
5. Monitor progress and recover from stalled edit loops automatically.



## Configuration
Configuration is loaded via **cosmiconfig** and supports both global and repository‑specific settings (see `src/core/config.ts`). Example `toki.toml`:
```toml
[global]
model = "nim"
apiKey = "YOUR_API_KEY"



[repo]
provider = "openrouter"
model = "gpt-4o"
```

## Development
- Run tests: `npm test`
- Watch tests: `npm run test:watch`
- Run e2e tests: `npm run test:e2e`
- Lint/formatting is handled by your editor (project uses TypeScript strict mode).

## Project Structure
```
packages/
  agent-core/    # Core loop policies and tool call abstractions
  coding-agent/  # Full coding agent with context broker, compressor, graph, orchestrator
    src/
      core/           # Orchestrator, prompt builder, engine core, tool runtime, system prompts
      task/           # Task frame and intent detection
      tools/          # Tool definitions (read, edit, write, bash, grep, find, ls)
      graph/          # Context graph for file/symbol relationships
      broker/         # Context broker for relevance scoring
      ledger/         # Context ledger for tracking
      compressor/     # History compression for token limits
      orchestrator/   # Prompt builder and orchestrator
      config.ts       # Configuration loading with cosmiconfig
      engine.ts       # Main coding agent engine
  providers/     # LLM provider implementations (Nim, OpenRouter, MiniMax, Scripted)
  shared/        # Shared types and utilities
  tui/           # Interactive terminal UI built with Ink/React

src/
  cli/           # Ink TUI entry point
  commands/      # CLI command registry and built‑ins
  core/          # Core engine, broker, graph, task framing
  providers/     # Provider registry and catalog (legacy)
  utils/         # Helpers (fs, hash, tokens, tree‑sitter, text)
  index.ts       # Main entry point

tests/
  unit/          # Unit tests for core components
  e2e/            # End-to-end tests (cli, edit recovery)
  broker.test.ts
  editLoopPolicy.test.ts
  engine.test.ts
  taskFrame.test.ts
  toolCalls.test.ts
  tuiSanitization.test.ts
  cli.e2e.test.ts
  editRecovery.e2e.test.ts
  promptBuilder.test.ts
  systemPrompt.test.ts
```

## Architecture
The project uses a monorepo with reusable packages:
- **@toki/agent-core**: Core loop policies and tool call abstractions
- **@toki/coding-agent**: Complete coding agent with context management
- **@toki/providers**: Pluggable LLM provider implementations
- **@toki/shared**: Shared types and utilities across packages
- **@toki/tui**: Terminal UI component


## Contributing
Contributions welcome! Please see the issues for planned features and open bugs.

## License
MIT © 2024-2025 Toki contributors
