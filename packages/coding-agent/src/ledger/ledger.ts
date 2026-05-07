import { ContextReceipt } from "@toki/shared";

export class ContextLedger {
  private receipts: ContextReceipt[];

  public constructor() {
    this.receipts = [];
  }

  public record(receipt: ContextReceipt): void {
    this.receipts.push(receipt);
  }

  public current(): ContextReceipt | undefined {
    return this.receipts.at(-1);
  }

  public list(): ContextReceipt[] {
    return [...this.receipts];
  }

  public clear(): void {
    this.receipts = [];
  }

  public explainPath(filePath: string): string {
    const current = this.current();
    if (!current) {
      return `No context receipt exists yet for: ${filePath}`;
    }
    const loaded = current.loaded.find((item) => item.path === filePath);
    if (loaded) {
      return `${filePath} loaded as ${loaded.representation}: ${loaded.reason}`;
    }
    const skipped = current.skipped.find((item) => item.path === filePath);
    if (skipped) {
      return `${filePath} skipped: ${skipped.reason}`;
    }
    return `${filePath} was not part of this turn candidate set.`;
  }
}
