export type ContextItemType =
  | "file"
  | "symbol"
  | "import_export"
  | "snippet"
  | "summary"
  | "tool_result"
  | "history"
  | "repo_rule"
  | "pinned";

export type FileRepresentation =
  | "path_only"
  | "outline"
  | "symbols"
  | "imports_exports"
  | "targeted_snippet"
  | "cached_summary"
  | "full_file";

export interface ContextItem {
  id: string;
  type: ContextItemType;
  path?: string;
  representation: FileRepresentation;
  content: string;
  estimatedTokens: number;
  relevanceScore: number;
  freshness: number;
  source: string;
  reason: string;
  priority: number;
}

export interface TaskFrameEntities {
  paths: string[];
  symbols: string[];
  errors: string[];
  domains: string[];
}

export interface TaskFrame {
  raw: string;
  objective: string;
  intent: string;
  entities: TaskFrameEntities;
  risk: "low" | "medium" | "high";
  needsEdit: boolean;
  needsTests: boolean;
  confidence: number;
}

export type PhaseStatus = "pending" | "active" | "done" | "blocked";

export interface Phase {
  id: string;
  name: string;
  goal: string;
  status: PhaseStatus;
  entryCriteria: string[];
  exitCriteria: string[];
  expectedArtifacts: string[];
  maxContextMode: BudgetMode;
}

export interface Checkpoint {
  task: string;
  phase: string;
  completed: string[];
  filesChanged: string[];
  decisions: string[];
  currentState: string;
  nextSteps: string[];
  knownIssues: string[];
  commandsRun: string[];
}

export interface CachedSummary {
  path: string;
  fileHash: string;
  summary: string;
  tokenCount: number;
  createdAt: string;
  summarizer: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  contextWindow?: number;
}

export type BudgetMode = "auto" | "tiny" | "normal" | "deep";

export interface BudgetSettings {
  tinyCeiling: number;
  normalCeiling: number;
  deepCeiling: number;
}

export interface RuntimeSettings {
  modelRoundTimeoutMs: number;
  modelRoundRetries: number;
  modelRoundRetryBackoffMs: number;
  maxToolRounds: number;
  editToolCallRetries: number;
  autoRunChecksAfterEdit?: boolean;
  autoRunChecksTimeoutSec?: number;
}

export interface GlobalConfig {
  defaultModel: string;
  defaultProvider: string;
  mode: BudgetMode;
  showReceipts: boolean;
  budget: BudgetSettings;
  runtime: RuntimeSettings;
  providerApiKeys: Record<string, string>;
}

export interface RepoConfig {
  repoType: string;
  testCommand: string;
  generatedPaths: string[];
  importantPaths: string[];
  postEditChecks?: string[];
}

export interface ProviderChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface ChatChunk {
  text: string;
  done: boolean;
  channel?: "content" | "reasoning";
}

export interface ChatResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ContextReceipt {
  turn: number;
  mode: BudgetMode;
  ceiling: number;
  usedTokens: number;
  savedTokens: number;
  loaded: ContextItem[];
  skipped: Array<{
    path: string;
    reason: string;
    estimatedTokens: number;
  }>;
  compressed: Array<{
    source: string;
    fromTokens: number;
    toTokens: number;
    method: string;
  }>;
}

export interface CandidateFile {
  path: string;
  estimatedTokens: number;
  relevanceScore: number;
  freshness: number;
  priority: number;
  reason: string;
}

export interface FileIndexEntry {
  path: string;
  ext: string;
  sizeBytes: number;
  estimatedTokens: number;
  lastModifiedMs: number;
  hash: string;
}

export interface SymbolEntry {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
}

export interface SymbolIndexEntry {
  path: string;
  exports: SymbolEntry[];
  imports: string[];
}

export interface RepoIndexState {
  generatedAt: string;
  files: FileIndexEntry[];
  symbols: SymbolIndexEntry[];
  tokenCounts: Record<string, number>;
  summaries: Record<string, CachedSummary>;
}
