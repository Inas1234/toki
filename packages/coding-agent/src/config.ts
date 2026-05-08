import os from "node:os";
import path from "node:path";
import { cosmiconfig } from "cosmiconfig";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import { z } from "zod";
import { BudgetMode, GlobalConfig, RepoConfig, ensureDir, fileExists, readTextFile, writeTextFile } from "@toki/shared";

const globalSchema = z.object({
  default_model: z.string().default("llama-3.1-nemotron-ultra"),
  default_provider: z.string().default("nim"),
  mode: z.enum(["auto", "tiny", "normal", "deep"]).default("auto"),
  show_receipts: z.boolean().default(true),
  nvidia_api_key: z.string().optional(),
  openrouter_api_key: z.string().optional(),
  minimax_api_key: z.string().optional(),
  providers: z
    .object({
      nim: z
        .object({
          api_key: z.string().optional()
        })
        .optional(),
      openrouter: z
        .object({
          api_key: z.string().optional()
        })
        .optional(),
      minimax: z
        .object({
          api_key: z.string().optional()
        })
        .optional()
    })
    .default({}),
  budget: z
    .object({
      tiny_ceiling: z.number().int().positive().default(4000),
      normal_ceiling: z.number().int().positive().default(12000),
      deep_ceiling: z.number().int().positive().default(24000)
    })
    .default({
      tiny_ceiling: 4000,
      normal_ceiling: 12000,
      deep_ceiling: 24000
    }),
  runtime: z
    .object({
      model_round_timeout_ms: z.number().int().positive().default(45000),
      model_round_retries: z.number().int().min(0).default(2),
      model_round_retry_backoff_ms: z.number().int().positive().default(1000),
      max_tool_rounds: z.number().int().positive().default(8),
      edit_tool_call_retries: z.number().int().min(0).default(4),
      auto_run_checks_after_edit: z.boolean().default(true),
      auto_run_checks_timeout_sec: z.number().int().positive().default(180)
    })
    .default({
      model_round_timeout_ms: 45000,
      model_round_retries: 2,
      model_round_retry_backoff_ms: 1000,
      max_tool_rounds: 8,
      edit_tool_call_retries: 4,
      auto_run_checks_after_edit: true,
      auto_run_checks_timeout_sec: 180
    })
});

const repoSchema = z.object({
  repo_type: z.string().default("generic"),
  test_command: z.string().default("npm test"),
  generated_paths: z.array(z.string()).default(["dist", "node_modules", ".git"]),
  important_paths: z.array(z.string()).default([]),
  post_edit_checks: z.array(z.string()).default([])
});

export interface ResolvedConfig {
  global: GlobalConfig;
  repo: RepoConfig;
  paths: {
    repoConfigPath: string;
    globalConfigPath: string;
    repoRulesPath: string;
    repoIndexDir: string;
    globalDir: string;
    repoDir: string;
  };
}

function rawGlobalDefaults(): z.input<typeof globalSchema> {
  return {
    default_model: "llama-3.1-nemotron-ultra",
    default_provider: "nim",
    mode: "auto",
    show_receipts: true,
    budget: {
      tiny_ceiling: 4000,
      normal_ceiling: 12000,
      deep_ceiling: 24000
    },
    runtime: {
      model_round_timeout_ms: 45000,
      model_round_retries: 2,
      model_round_retry_backoff_ms: 1000,
      max_tool_rounds: 8,
      edit_tool_call_retries: 4,
      auto_run_checks_after_edit: true,
      auto_run_checks_timeout_sec: 180
    }
  };
}

function rawRepoDefaults(): z.input<typeof repoSchema> {
  return {
    repo_type: "generic",
    test_command: "npm test",
    generated_paths: ["dist", "node_modules", ".git", ".toki/index"],
    important_paths: [],
    post_edit_checks: []
  };
}

function toGlobalConfig(raw: z.infer<typeof globalSchema>): GlobalConfig {
  const providerApiKeys: Record<string, string> = {};
  const nimKey = raw.providers.nim?.api_key ?? raw.nvidia_api_key;
  if (nimKey && nimKey.trim().length > 0) {
    providerApiKeys.nim = nimKey.trim();
  }
  const openrouterKey = raw.providers.openrouter?.api_key ?? raw.openrouter_api_key;
  if (openrouterKey && openrouterKey.trim().length > 0) {
    providerApiKeys.openrouter = openrouterKey.trim();
  }
  const minimaxKey = raw.providers.minimax?.api_key ?? raw.minimax_api_key;
  if (minimaxKey && minimaxKey.trim().length > 0) {
    providerApiKeys.minimax = minimaxKey.trim();
  }
  const base: GlobalConfig = {
    defaultModel: raw.default_model,
    defaultProvider: raw.default_provider,
    mode: raw.mode,
    showReceipts: raw.show_receipts,
    providerApiKeys,
    budget: {
      tinyCeiling: raw.budget.tiny_ceiling,
      normalCeiling: raw.budget.normal_ceiling,
      deepCeiling: raw.budget.deep_ceiling
    },
    runtime: {
      modelRoundTimeoutMs: raw.runtime.model_round_timeout_ms,
      modelRoundRetries: raw.runtime.model_round_retries,
      modelRoundRetryBackoffMs: raw.runtime.model_round_retry_backoff_ms,
      maxToolRounds: raw.runtime.max_tool_rounds,
      editToolCallRetries: raw.runtime.edit_tool_call_retries,
      autoRunChecksAfterEdit: raw.runtime.auto_run_checks_after_edit,
      autoRunChecksTimeoutSec: raw.runtime.auto_run_checks_timeout_sec
    }
  };
  return base;
}

function toRepoConfig(raw: z.infer<typeof repoSchema>): RepoConfig {
  return {
    repoType: raw.repo_type,
    testCommand: raw.test_command,
    generatedPaths: raw.generated_paths,
    importantPaths: raw.important_paths,
    postEditChecks: raw.post_edit_checks
  };
}

function serializeToml(value: object): string {
  return `${stringifyToml(value as never)}`;
}

function toRawGlobalConfig(config: GlobalConfig): z.input<typeof globalSchema> {
  const nimKey = config.providerApiKeys.nim;
  const openrouterKey = config.providerApiKeys.openrouter;
  const minimaxKey = config.providerApiKeys.minimax;
  const raw: z.input<typeof globalSchema> = {
    default_model: config.defaultModel,
    default_provider: config.defaultProvider,
    mode: config.mode,
    show_receipts: config.showReceipts,
    budget: {
      tiny_ceiling: config.budget.tinyCeiling,
      normal_ceiling: config.budget.normalCeiling,
      deep_ceiling: config.budget.deepCeiling
    },
    runtime: {
      model_round_timeout_ms: config.runtime.modelRoundTimeoutMs,
      model_round_retries: config.runtime.modelRoundRetries,
      model_round_retry_backoff_ms: config.runtime.modelRoundRetryBackoffMs,
      max_tool_rounds: config.runtime.maxToolRounds,
      edit_tool_call_retries: config.runtime.editToolCallRetries,
      auto_run_checks_after_edit: config.runtime.autoRunChecksAfterEdit ?? true,
      auto_run_checks_timeout_sec: config.runtime.autoRunChecksTimeoutSec ?? 180
    },
    providers: {}
  };
  if (nimKey) {
    raw.providers = {
      nim: {
        api_key: nimKey
      }
    };
    raw.nvidia_api_key = nimKey;
  }
  if (openrouterKey) {
    raw.providers = {
      ...raw.providers,
      openrouter: {
        api_key: openrouterKey
      }
    };
    raw.openrouter_api_key = openrouterKey;
  }
  if (minimaxKey) {
    raw.providers = {
      ...raw.providers,
      minimax: {
        api_key: minimaxKey
      }
    };
    raw.minimax_api_key = minimaxKey;
  }
  return raw;
}

export function modeToCeiling(mode: BudgetMode, globalConfig: GlobalConfig): number {
  if (mode === "tiny") {
    return globalConfig.budget.tinyCeiling;
  }
  if (mode === "normal") {
    return globalConfig.budget.normalCeiling;
  }
  if (mode === "deep") {
    return globalConfig.budget.deepCeiling;
  }
  return globalConfig.budget.normalCeiling;
}

export async function loadConfig(cwd: string): Promise<ResolvedConfig> {
  const repoDir = cwd;
  const repoConfigDir = path.join(repoDir, ".toki");
  const repoConfigPath = path.join(repoConfigDir, "config.toml");
  const repoRulesPath = path.join(repoConfigDir, "rules.md");
  const repoIndexDir = path.join(repoConfigDir, "index");
  const globalDir = path.join(os.homedir(), ".toki");
  const globalConfigPath = path.join(globalDir, "config.toml");

  await ensureDir(repoConfigDir);
  await ensureDir(repoIndexDir);
  await ensureDir(globalDir);

  if (!(await fileExists(repoConfigPath))) {
    await writeTextFile(repoConfigPath, serializeToml(rawRepoDefaults() as Record<string, unknown>));
  }
  if (!(await fileExists(globalConfigPath))) {
    await writeTextFile(globalConfigPath, serializeToml(rawGlobalDefaults() as Record<string, unknown>));
  }

  const explorer = cosmiconfig("toki", {
    searchPlaces: [".toki/config.toml"],
    loaders: {
      ".toml": (_filePath: string, content: string): unknown => parseToml(content)
    }
  });

  const repoLoaded = await explorer.search(repoDir);
  const rawRepo = repoSchema.parse((repoLoaded?.config ?? rawRepoDefaults()) as unknown);

  const globalRawText = await readTextFile(globalConfigPath);
  const rawGlobal = globalSchema.parse(parseToml(globalRawText) as unknown);

  return {
    global: toGlobalConfig(rawGlobal),
    repo: toRepoConfig(rawRepo),
    paths: {
      repoConfigPath,
      globalConfigPath,
      repoRulesPath,
      repoIndexDir,
      globalDir,
      repoDir
    }
  };
}

export async function saveGlobalConfig(global: GlobalConfig, globalConfigPath: string): Promise<void> {
  const content = serializeToml(toRawGlobalConfig(global) as Record<string, unknown>);
  await writeTextFile(globalConfigPath, content);
}
