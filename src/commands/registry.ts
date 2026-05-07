import { CommandContext, CommandHandler, CommandResult } from "./types.js";

export class CommandRegistry {
  private handlers: Map<string, CommandHandler>;

  public constructor(handlers: CommandHandler[]) {
    this.handlers = new Map(handlers.map((handler) => [handler.name, handler]));
  }

  public listHandlers(): CommandHandler[] {
    return [...this.handlers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  public async execute(input: string, context: CommandContext): Promise<CommandResult> {
    if (!input.startsWith("/")) {
      return {
        handled: false,
        output: ""
      };
    }
    const [name, ...args] = input.slice(1).trim().split(/\s+/);
    const key = name?.toLowerCase() ?? "";
    const handler = this.handlers.get(key);
    if (!handler) {
      return {
        handled: true,
        output: `Unknown command: /${key}. Use /help.`,
        error: true
      };
    }
    return handler.run(args.join(" "), context);
  }
}
