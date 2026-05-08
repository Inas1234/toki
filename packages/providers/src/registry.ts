import { GlobalConfig } from "@toki/shared";
import { ModelProvider } from "./base.js";
import { PROVIDER_DEFINITIONS, ProviderDefinition } from "./catalog.js";
import { NimProvider } from "./nim.js";
import { MiniMaxProvider } from "./minimax.js";
import { OpenRouterProvider } from "./openrouter.js";
import { ScriptedProvider } from "./scripted.js";

const TEST_PROVIDER_ENV_KEY = "TOKI_TEST_PROVIDER_SCRIPT";
const SCRIPTED_PROVIDER_DEFINITION: ProviderDefinition = {
  id: "scripted",
  name: "Scripted",
  requiredCredentials: []
};

export interface ProviderListItem {
  id: string;
  name: string;
  configured: boolean;
}

export class ProviderRegistry {
  private readonly config: GlobalConfig;

  public constructor(config: GlobalConfig) {
    this.config = config;
  }

  public listDefinitions(): ProviderDefinition[] {
    return process.env[TEST_PROVIDER_ENV_KEY] ? [...PROVIDER_DEFINITIONS, SCRIPTED_PROVIDER_DEFINITION] : [...PROVIDER_DEFINITIONS];
  }

  public listProviders(): ProviderListItem[] {
    return this.listDefinitions().map((definition) => ({
      id: definition.id,
      name: definition.name,
      configured: this.isConfigured(definition.id)
    }));
  }

  public getDefinition(id: string): ProviderDefinition | undefined {
    return PROVIDER_DEFINITIONS.find((definition) => definition.id === id);
  }

  public isConfigured(providerId: string): boolean {
    if (providerId === "scripted") {
      const value = process.env[TEST_PROVIDER_ENV_KEY];
      return typeof value === "string" && value.trim().length > 0;
    }
    if (providerId === "nim") {
      const value = this.config.providerApiKeys.nim ?? process.env.NVIDIA_API_KEY;
      return typeof value === "string" && value.trim().length > 0;
    }
    if (providerId === "openrouter") {
      const value = this.config.providerApiKeys.openrouter ?? process.env.OPENROUTER_API_KEY;
      return typeof value === "string" && value.trim().length > 0;
    }
    if (providerId === "minimax") {
      const value = this.config.providerApiKeys.minimax ?? process.env.MINIMAX_API_KEY;
      return typeof value === "string" && value.trim().length > 0;
    }
    return false;
  }

  public get(providerId: string): ModelProvider {
    if (providerId === "scripted") {
      const fixturePath = process.env[TEST_PROVIDER_ENV_KEY];
      if (!fixturePath || fixturePath.trim().length === 0) {
        throw new Error("Scripted provider requires TOKI_TEST_PROVIDER_SCRIPT");
      }
      return new ScriptedProvider(fixturePath);
    }
    if (providerId === "nim") {
      const key = this.config.providerApiKeys.nim ?? process.env.NVIDIA_API_KEY;
      return new NimProvider(key ? { apiKey: key } : {});
    }
    if (providerId === "openrouter") {
      const key = this.config.providerApiKeys.openrouter ?? process.env.OPENROUTER_API_KEY;
      return new OpenRouterProvider(key ? { apiKey: key } : {});
    }
    if (providerId === "minimax") {
      const key = this.config.providerApiKeys.minimax ?? process.env.MINIMAX_API_KEY;
      return new MiniMaxProvider(key ? { apiKey: key } : {});
    }
    throw new Error(`Unknown provider: ${providerId}`);
  }
}
