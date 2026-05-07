# Toki

A minimal, extensible CLI coding agent focused on automatic context efficiency.

> ⚠️ **Status**: Project is in early development. Core features are being actively built.

## Features
- **Monorepo architecture**: Reusable packages for agent core, coding agent, providers, and shared utilities.
- **Context‑aware**: Uses a graph‑based context broker to select the most relevant files.
- **Pluggable providers**: Supports multiple LLM providers (Nim, OpenRouter, MiniMax, etc.) via a unified interface.
- **Task framing**: Detects intent, risk, and required edits/tests from natural‑language commands.
- **Compression**: Smart history compression to stay within token limits.
- **TUI**: Interactive terminal UI built with Ink/React.

## Getting Started
```bash
# Install dependencies
npm install

# Build the UI package
npm run build -w @toki/tui

# Run the CLI in development mode
npm run dev
```


## Usage
```bash
# Run a command
node dist/index.js <your‑prompt>
```

The CLI will:
1. Parse your prompt into a **TaskFrame** (intent, risk, edit/test flags).
2. Select relevant context files via **ContextBroker**.
3. Build a prompt with **PromptBuilder** and send it to the configured model.
4. Apply edits or run tests based on the model's response.


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
- Lint/formatting is handled by your editor (project uses TypeScript strict mode).

## Project Structure
```
packages/
  agent-core/    # Core agent loop policy and tool call handling
  coding-agent/  # Full coding agent with context broker, compressor, graph, orchestrator
  providers/     # LLM provider implementations (Nim, OpenRouter, MiniMax)
  shared/        # Shared types and utilities
  tui/           # Interactive terminal UI built with Ink/React

src/
  cli/           # Ink TUI entry point
  commands/      # CLI command registry and built‑ins
  core/          # Core engine, broker, graph, task framing
  providers/     # Provider registry and catalog (legacy)
  utils/         # Helpers (fs, hash, tokens, tree‑sitter, text)
  index.ts       # Main entry point

tests/          # Vitest test suite
```

## Architecture
The project has evolved into a monorepo with reusable packages:
- **@toki/agent-core**: Core loop policies and tool call abstractions
- **@toki/coding-agent**: Complete coding agent with context management
- **@toki/providers**: Pluggable LLM provider implementations
- **@toki/shared**: Shared types and utilities across packages
- **@toki/tui**: Terminal UI component

## Contributing
Contributions welcome! Please see the issues for planned features and open bugs.

## License
MIT © 2024 Toki contributors
