# Toki

A minimal, extensible CLI coding agent focused on automatic context efficiency.

## Features
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
src/
  core/          # Engine, orchestrator, ledger, broker, graph
  providers/     # LLM provider implementations
  utils/         # Helpers (fs, hash, tokens, tree‑sitter, text)
  commands/      # CLI command registry and built‑ins
  cli/           # Ink TUI entry point
packages/tui/   # Separate UI package
tests/          # Vitest test suite
```

## License
MIT © 2024 Toki contributors
