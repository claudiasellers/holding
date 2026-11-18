// TTS provider contract + registry. Default is the browser's built-in speech
// (on-device OS voices, free). Kokoro (in-browser neural TTS) is optional.
//
// interface TTSProvider {
//   id: string                       // 'webspeech' | 'kokoro' | 'piper-server' | ...
//   label: string
//   local: boolean
//   isAvailable(cfg): Promise<{ok:boolean, reason?:string}>
//   init?(cfg, onProgress?): Promise<void>
//   listVoices(cfg): Promise<{id:string, label:string, lang?:string, gender?:'f'|'m'|'n'}[]>
//   speak(text, opts: {
//     voiceId?: string, rate: number /*0.5-1.5*/, pitch: number /*0.5-1.5*/, volume?: number,
//     onStart?: () => void, onEnd?: () => void,
//     onLevel?: (level0to1:number) => void   // mouth/lip-sync drive, ~30-60 Hz if possible
//     signal?: AbortSignal,
//   }): Promise<void>                // resolves when finished or aborted
//   stop(): void
// }
// Audio must only start after a user gesture (iOS). The UI calls unlockAudio() on first tap.

const registry = new Map();
export function registerTTSProvider(p) { registry.set(p.id, p); }
export function getTTSProvider(id) { return registry.get(id); }
export function listTTSProviders() { return [...registry.values()]; }
