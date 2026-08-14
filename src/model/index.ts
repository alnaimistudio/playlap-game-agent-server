import { config } from "../config.js";
import { ModelProvider } from "./provider.js";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";

export function createProvider(): ModelProvider {
  switch (config.modelProvider) {
    case "mock":
      return new MockProvider();
    case "openai-compatible": {
      if (!config.modelBaseUrl) throw new Error("MODEL_BASE_URL is required for MODEL_PROVIDER=openai-compatible");
      return new OpenAICompatibleProvider("openai-compatible", config.modelBaseUrl, config.modelApiKey, config.modelName);
    }
    case "local": {
      const base = config.modelBaseUrl || "http://127.0.0.1:8080/v1";
      return new OpenAICompatibleProvider("local", base, config.modelApiKey, config.modelName);
    }
    default:
      throw new Error(`Unknown MODEL_PROVIDER: ${config.modelProvider}`);
  }
}
