// LLM provider contract + registry. Every provider is local-first; nothing here
// calls a paid API unless the user explicitly configures a custom endpoint.
//
// interface LLMProvider {
//   id: string                       // 'scripted' | 'webllm' | 'openai-local' | 'holding-rag' | ...
//   label: string                    // shown in Settings
//   local: boolean                   // true = runs on this device / user's own machine
//   isAvailable(cfg): Promise<{ok: boolean, reason?: string}>
//   init(cfg, onProgress?: (p:{text:string, progress:number}) => void): Promise<void>
//   generate(req: {
//     system: string,                // persona + turn-policy prompt (built by engine/prompt.js)
//     messages: {role:'user'|'assistant', content:string}[],
//     maxTokens: number, temperature: number,
//     archetype: Archetype,          // full archetype object (see archetypes/schema.js)
//     signal?: AbortSignal,
//   }): Promise<string>              // plain text reply; engine validates + falls back to scripts
//   dispose?(): Promise<void>
// }
//
// cfg is the provider's slice of settings: settings.ai[provider.id] (free-form object).

const registry = new Map();

export function registerLLMProvider(p) {
  if (!p || !p.id || typeof p.generate !== 'function') throw new Error('bad provider');
  registry.set(p.id, p);
}
export function getLLMProvider(id) { return registry.get(id); }
export function listLLMProviders() { return [...registry.values()]; }
