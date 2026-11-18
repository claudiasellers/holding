// Phone-safe settings for the in-browser WebLLM provider (src/ai/ owned by the core app).
// The core 'webllm' provider imports these helpers so phones get a model that can actually load
// and prompts that don't trip Safari's GPU watchdog.
//
// Facts this file encodes (WebLLM 0.2.89):
//  - WebLLM requests a 1 GB maxStorageBufferBindingSize and falls back to 128 MB. Below 1 GB,
//    only models with low_resource_required: true load. iPhones expose well under 1 GB, so
//    Qwen3.5-2B (low_resource_required: false) cannot run there.
//  - q4f16 models need the 'shader-f16' feature; without it use the q4f32 build.
//  - Long single-pass prefills (~900 tokens) have crashed Safari's GPU process on iOS 27.
//    Keep the first prompt short; WebLLM reuses the KV cache across turns of one chat,
//    so later turns only prefill the new message.

const STORE_KEY = 'holding.mobile.v1';

/** Candidate models, best first, per GPU class. IDs are WebLLM prebuilt model_ids. */
export const MODEL_LADDER = {
  // Desktop/laptop browsers and Android phones whose GPU allows 1 GB bindings.
  big: [
    { id: 'Qwen3.5-2B-q4f16_1-MLC', label: 'Qwen3.5 2B', sizeMB: 2245, thinking: true },
    { id: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC', label: 'Hermes 3 (Llama 3.2 3B)', sizeMB: 2264, thinking: false },
    { id: 'Qwen3.5-0.8B-q4f16_1-MLC', label: 'Qwen3.5 0.8B', sizeMB: 1629, thinking: true },
  ],
  // iPhones/iPads and most phones: low_resource_required models only.
  small: [
    { id: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC', label: 'Hermes 3 (Llama 3.2 3B)', sizeMB: 2264, thinking: false, tier: 'larger' },
    { id: 'Qwen3.5-0.8B-q4f16_1-MLC', label: 'Qwen3.5 0.8B', sizeMB: 1629, thinking: true, tier: 'compact' },
  ],
};

function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (_) { return {}; }
}
function writeStore(patch) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...readStore(), ...patch })); } catch (_) {}
}

export function recordModelFailure(modelId, reason) {
  const s = readStore();
  const failed = { ...(s.failedModels || {}), [modelId]: { reason: String(reason || '').slice(0, 200), at: Date.now() } };
  writeStore({ failedModels: failed });
}
export function recordModelSuccess(modelId) {
  const s = readStore();
  const failed = { ...(s.failedModels || {}) };
  delete failed[modelId];
  writeStore({ failedModels: failed, workingModel: modelId });
}
export function clearModelFailures() { writeStore({ failedModels: {} }); }

/**
 * Pick the WebLLM model for this device.
 * @param {object} probe  result of probeDevice()
 * @param {object} [opts]
 * @param {'auto'|'larger'|'compact'} [opts.size='auto']
 * @param {string} [opts.override]  explicit model_id chosen in settings
 * @returns {{id:string,label:string,sizeMB:number,thinking:boolean}|null}
 */
export function pickWebLLMModel(probe, { size = 'auto', override } = {}) {
  if (!probe || !probe.canRunLocalModel) return null;
  const store = readStore();
  const failed = store.failedModels || {};
  const f32 = (m) => (probe.gpu.f16 ? m : { ...m, id: m.id.replace('q4f16_1', 'q4f32_1'), sizeMB: Math.round(m.sizeMB * 1.35) });

  if (override) return f32({ id: override, label: override, sizeMB: 0, thinking: /qwen3/i.test(override) });

  let ladder = (probe.bigBuffers ? MODEL_LADDER.big : MODEL_LADDER.small).map(f32);
  // Phones: on 'auto', start compact. iOS can't report RAM, and a jetsam kill mid-session is the
  // worst failure for this app. 'larger' is offered in settings for iPhone 15 Pro and newer.
  if (!probe.bigBuffers && size !== 'larger') ladder = ladder.slice().sort((a, b) => a.sizeMB - b.sizeMB);
  if (probe.bigBuffers && size === 'compact') ladder = ladder.slice().sort((a, b) => a.sizeMB - b.sizeMB);
  // Storage check: need room for the weights plus headroom.
  const freeMB = probe.storage.quotaMB != null && probe.storage.usageMB != null ? probe.storage.quotaMB - probe.storage.usageMB : Infinity;
  for (const m of ladder) {
    if (failed[m.id]) continue;
    if (m.sizeMB * 1.15 > freeMB) continue;
    return m;
  }
  return null;
}

/** ChatOptions overrides for CreateMLCEngine(modelId, engineConfig, chatOptions). */
export function mobileChatOptions(probe) {
  if (!probe || !probe.isMobile) return {};
  // A 2k window is plenty for short, paced replies and cuts KV-cache memory in half.
  return { context_window_size: 2048 };
}

/**
 * Token budget for the first prompt (system + history) before the first reply.
 * Conservative on iOS because of the GPU-watchdog crash on long prefills.
 */
export function promptBudgetTokens(probe) {
  if (!probe) return 1500;
  if (probe.isIOS) return 600;
  if (probe.isMobile) return 1200;
  return 3000;
}

/** Rough token estimate (~4 chars per token for English). */
export function estimateTokens(text) { return Math.ceil(String(text || '').length / 4); }

/**
 * Trim oldest turns until system + messages fit the budget. Keeps the system prompt and the
 * newest user turn no matter what.
 */
export function fitToBudget(system, messages, budget) {
  const sys = estimateTokens(system);
  const out = messages.slice();
  let total = sys + out.reduce((n, m) => n + estimateTokens(m.content), 0);
  while (out.length > 1 && total > budget) {
    const removed = out.shift();
    total -= estimateTokens(removed.content);
  }
  return out;
}

/** Request extras that keep Qwen3.x from "thinking" out loud. */
export function noThinkingRequestExtras(model) {
  if (!model || !model.thinking) return {};
  return { extra_body: { enable_thinking: false } };
}

/** Remove any <think>…</think> block (and an unterminated one) from model output. */
export function stripThinking(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/^\s+/, '');
}

/** True when an error looks like the GPU going away (Safari GPU process crash, OOM). */
export function isGpuLossError(err) {
  const msg = String((err && (err.message || err)) || '');
  return /device (was )?lost|destroyed|mapAsync|out of memory|OOM|GPUDevice|Cannot initialize runtime/i.test(msg);
}
