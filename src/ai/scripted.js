// Scripted provider: always available, no model, no download, no network.
// generate() returns '' which tells the dialogue engine to use the script library.
import { registerLLMProvider } from './providers.js';

const scripted = {
  id: 'scripted',
  label: 'Scripted lines (no AI, works everywhere)',
  local: true,
  async isAvailable() { return { ok: true }; },
  async init(_cfg, onProgress) { onProgress?.({ text: 'Ready', progress: 1 }); },
  async generate() { return ''; },
  async dispose() {},
};

registerLLMProvider(scripted);
export default scripted;
