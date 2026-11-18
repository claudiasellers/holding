// Chatterbox in the browser: an expressive neural voice with an emotion dial,
// on the graphics chip (WebGPU). About 1.5 GB, downloaded once into the
// browser's model cache; after that it speaks fully on this computer.
// Too big for phones: they use Holding Local's Chatterbox over Wi-Fi instead.
// The playback and reference-voice plumbing is in expressive-provider.js.
import { createChatterbox } from './chatterbox-core.js';
import { makeVoiceCopyProvider, loadTransformers, gpuHasF16, TRANSFORMERS_VERSION, BUILTIN_VOICE } from './expressive-provider.js';

export { TRANSFORMERS_VERSION, BUILTIN_VOICE };

const chatterbox = makeVoiceCopyProvider({
  id: 'chatterbox',
  label: 'Expressive voice on this computer (Chatterbox, ~1.5 GB)',
  name: 'Chatterbox',
  sizeText: 'about 1.5 GB',
  feeling: true,
  async createEngine(onFile, onPreparing) {
    const lib = await loadTransformers();
    const e = createChatterbox(lib, { device: 'webgpu', f16: await gpuHasF16() });
    await e.load((p) => {
      if (p?.status === 'progress' && p.file) onFile(p.file, p.loaded, p.total);
      else if (p?.status === 'ready') onPreparing();
    });
    return e;
  },
});

export default chatterbox;
