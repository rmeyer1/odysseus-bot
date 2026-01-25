import CodexCliProvider from "./CodexCliProvider.mjs";
import GeminiProvider from "./GeminiProvider.mjs";

export function createProviderManager({ sendMessageSafe }) {
  const providers = {
    codex: new CodexCliProvider({ sendMessageSafe }),
    gemini: new GeminiProvider(),
  };

  function getProvider(name) {
    const key = String(name || "codex").toLowerCase();
    return providers[key] || providers.codex;
  }

  return { getProvider };
}
