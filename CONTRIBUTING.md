# Contributing to **Toki**

Thank you for considering a contribution! This project is a minimal, extensible CLI coding agent. Below are the guidelines to help you get started and make the contribution process smooth.

## Table of Contents
1. [Getting the Code](#getting-the-code)  
2. [Development Setup](#development-setup)  
3. [Running the Project](#running-the-project)  
4. [Testing](#testing)  
5. [Code Style & Quality](#code-style--quality)  
6. [Submitting Changes](#submitting-changes)  
7. [License](#license)

---

### Getting the Code
```bash
git clone https://github.com/your-username/toki.git
cd toki
npm install
```

The repository uses **npm workspaces**; the UI lives in `packages/tui`.

### Development Setup
1. **Build the UI package** (required before running the CLI):
   ```bash
   npm run build -w @toki/tui
   ```
2. **Compile the TypeScript sources**:
   ```bash
   npm run build
   ```

### Running the Project
For quick iteration you can run the CLI directly from source:

```bash
npm run dev
```

This command builds the UI package and starts the CLI with `tsx src/index.ts`.  
You can also run the compiled version:

```bash
npm start   # runs node dist/index.js
```

### Testing
The project uses **Vitest**.

- Run all tests once:
  ```bash
  npm test
  ```
- Run tests in watch mode (useful during development):
  ```bash
  npm run test:watch
  ```

### Code Style & Quality
- The codebase is **strict TypeScript** (`tsconfig.json` enforces `strict`, `noUncheckedIndexedAccess`, etc.).
- Follow existing naming conventions and file organization (`src/core`, `src/providers`, `src/utils`, etc.).
- Linting is handled by the TypeScript compiler; ensure `npm run build` succeeds without errors.
- Keep the public API surface minimal; add new exports only when truly needed.

### Submitting Changes
1. **Create a branch** for your work:
   ```bash
   git checkout -b feat/your-feature
   ```
2. **Make your changes** and ensure the project builds and tests pass.
3. **Commit** with a clear, concise message.
4. **Push** the branch and open a Pull Request against `main`.
5. In the PR description, explain:
   - What problem is solved / feature added.
   - Any breaking changes.
   - How you tested it.

### License
By contributing, you agree that your contributions will be licensed under the **MIT License** (see `LICENSE`).

---

Happy coding! If you have any questions, feel free to open an issue or reach out to the maintainers.
