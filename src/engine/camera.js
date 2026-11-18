// Optional, opt-in camera mirroring. MediaPipe Face Landmarker runs entirely in
// the browser; frames never leave the device and are never stored. Produces a
// stable affect estimate with midrange contingency: it only reports a change
// after the user's face has held it for a moment, and not more often than
// every few seconds (vigilant, every-flicker mirroring predicts insecurity).
import { readBlendshapes } from './affect.js';

const VER = '1.2.0';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export async function startCamera(videoEl, onAffect, { holdMs = 1200, cooldownMs = 6000 } = {}) {
  const vision = await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
  const lm = await vision.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
    runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
  });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 }, audio: false });
  videoEl.srcObject = stream; videoEl.muted = true; videoEl.playsInline = true;
  await videoEl.play();
  let alive = true, cand = null, candSince = 0, lastFired = 0, lastAffect = 'calm', lastTs = -1;
  const smooth = {};
  function tick() {
    if (!alive) return;
    const now = performance.now();
    if (videoEl.readyState >= 2 && now !== lastTs) {
      lastTs = now;
      const r = lm.detectForVideo(videoEl, now);
      const cats = r?.faceBlendshapes?.[0]?.categories;
      if (cats) {
        for (const c of cats) smooth[c.categoryName] = (smooth[c.categoryName] ?? c.score) * .8 + c.score * .2;
        const { affect, intensity } = readBlendshapes(smooth);
        if (affect !== cand) { cand = affect; candSince = now; }
        else if (now - candSince > holdMs && affect !== lastAffect && now - lastFired > cooldownMs) {
          lastAffect = affect; lastFired = now;
          if (affect !== 'calm') onAffect(affect, intensity);
        }
      }
    }
    setTimeout(() => requestAnimationFrame(tick), 90);
  }
  tick();
  return () => { alive = false; stream.getTracks().forEach((t) => t.stop()); lm.close?.(); videoEl.srcObject = null; };
}
