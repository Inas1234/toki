export interface ProviderCredentialRequirement {
  key: string;
  label: string;
  masked?: boolean;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  requiredCredentials: ProviderCredentialRequirement[];
}

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: "nim",
    name: "NVIDIA NIM",
    requiredCredentials: [
      {
        key: "apiKey",
        label: "NVIDIA API Key",
        masked: true
      }
    ]
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    requiredCredentials: [
      {
        key: "apiKey",
        label: "OpenRouter API Key",
        masked: true
      }
    ]
  },
  {
    id: "minimax",
    name: "MiniMax",
    requiredCredentials: [
      {
        key: "apiKey",
        label: "MiniMax API Key",
        masked: true
      }
    ]
  }
];
