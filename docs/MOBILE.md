# Holding on your phone

No App Store, no Play Store, no Apple developer account. Pick whichever fits.

| You have | Do this | On-phone AI |
|---|---|---|
| iPhone (iOS 26+) | Open the app link in **Safari** → Share → **Add to Home Screen** | Yes, compact model (Qwen3.5 0.8B); larger (Hermes 3, 3B) as a setting on iPhone 15 Pro and newer |
| Android | Open the app link in **Chrome** → ⋮ → **Install app** | Yes; Qwen3.5 2B on phones whose GPU allows it |
| Android, no hosting / fully offline bundle | Download `holding.apk` from the latest release and open it | Only where the system WebView exposes WebGPU; otherwise uses your computer or scripted lines |
| Any phone + your Mac/PC | Pair with the desktop server over Tailscale (below) | Your computer's bigger model, private to your devices |

Scripted lines always work: no download, no network, prerecorded voice.

The app link is `https://claudiasellers.github.io/holding/` once GitHub Pages is on.

## iPhone notes

- **Use Safari for the install.** Chrome on iOS 16.4+ can also Add to Home Screen from its Share menu.
- **The first spoken line needs one tap.** iOS doesn't allow audio before you touch the screen, so "parent talks first" opens with one large "I'm here" button. After that the parent speaks without you typing or talking.
- **The Home Screen app has its own storage, separate from Safari.** A pairing link opened from the camera lands in Safari. Inside the installed app, use Settings → Your home computer and type the code your computer shows.
- **The model download (about 1.6 GB) happens once, on Wi-Fi, from inside the installed app.** iOS can clear it under storage pressure. If it does, the app falls back to scripted lines and offers to download it again.

## Pair with your Mac mini (or any computer)

1. Install Tailscale on the computer and on the phone, signed in to the same account. It's free and on the App Store.
2. On the computer: `repair-local start --tailscale` (see `local-ai/companion`). It runs `tailscale serve` and shows a QR code plus an 8-character pairing code.
3. On the phone, open the `https://<computer>.<tailnet>.ts.net` address and Add to Home Screen, then type the pairing code in Settings → Your home computer.
   Or, in the hosted app, enter that address and the code.

Plain `http://192.168…` addresses work for text and voice playback only. Phones block the camera (mirroring), the mic and install on plain http.

## Android APK

Every push to `main` builds `holding.apk` and attaches it to the release named `latest`:
`https://github.com/claudiasellers/holding/releases/latest/download/holding.apk`

- First install: open the file, then allow your browser to "install unknown apps" when Android asks.
- Google's developer verification: since Sept 30, 2026 it is enforced only in Brazil, Indonesia, Singapore and Thailand, and only for apps from the listed stores. The global rollout is planned for 2027. Installs over ADB are exempt (`adb install holding.apk`). A free limited-distribution developer account (no ID, no fee) covers up to 20 devices.
- Updates install over the old version only when they're signed with the same key. CI signs with the key in the repo secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Without them, CI builds a debug APK.

## For developers

- `src/mobile/register.js`: imported once by `main.js`. It registers `public/sw.js`, adds the head tags, consumes `#pair=`, asks for persistent storage, and exposes `window.HoldingMobile`.
- `src/mobile/device.js`: `probeDevice()` reports platform, standalone mode, WebGPU limits and storage.
- `src/mobile/webllm-mobile.js`: picks a model per device, plus phone-safe chat options, a prompt budget, thinking-mode stripping and failure memory.
- `src/mobile/pairing.js`: the home-server pairing UI and storage. It writes `settings.ai['openai-local']`.
- `src/mobile/install.js`: the platform-aware install sheet and chip.
- `scripts/build-mobile.mjs`: run after `vite build`. Writes `dist/precache.json`, stamps the service worker, and puts the iOS head tags in the static HTML.
- `scripts/prerender-voice.mjs`: renders every scripted line to `public/audio/<archetype>/<id>.mp3` with Kokoro, once, on a computer.
- `android/` plus `capacitor.config.json`: the Capacitor wrapper. Build with `npm run build && npx cap sync android && (cd android && ./gradlew assembleDebug)`.
- `.github/workflows/pages.yml` and `android.yml`: the web app on Pages, and the APK on releases.

Service worker rules: the app shell is cache-first and the page is stale-while-revalidate. Audio is served from a long-lived cache with proper `206` Range replies, because iOS needs them. Model weights (Hugging Face) pass through, since WebLLM and transformers.js keep their own caches. `/v1/` is never cached.
