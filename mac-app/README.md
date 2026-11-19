# Holding Local for Mac

A menu bar app that gives people Holding Local without the repo or a terminal. They open
`Holding-Local-mac.dmg`, drag the app to Applications, open it, and press **Set up**.

What it does:

- **Setup with real progress.** Copies the engine shipped inside the app to
  `~/Library/Application Support/Holding Local`, sets up Python and the voice and listening
  engines with the bundled `uv`, gets Ollama, then runs `holding-local setup --json`, which
  reports each download (voice, chat model picked for this Mac's memory, memory model) as
  JSON lines the app turns into progress bars.
- **Ollama without a second app.** Uses an Ollama that's already running or installed.
  Otherwise it downloads Ollama's standalone build (pinned version, SHA-256 checked) into its
  own folder, runs `ollama serve` while the app is open and stops it on quit. Models live in
  `~/.ollama` either way, so nothing is downloaded twice.
- **Start, stop, status.** A heart in the menu bar; the panel shows whether it's running and
  with which model. **Open Holding** opens `http://127.0.0.1:8787/?local=1`, and `?local=1`
  makes the web app switch to this Mac's AI, voice and listening by itself.
- **Phone pairing.** "Let my phone connect" restarts the engine with `--tailscale --lan`
  (or `--lan` without Tailscale). **Pair a phone…** shows the QR code and pairing code, warns
  when the link is plain http, and walks through the one-time Tailscale settings.
- **Chat models.** Lists the models in Ollama with their sizes, switches between them,
  downloads the recommended ones with progress, and deletes the ones you don't use (it won't
  delete the one in use), showing the space freed. Same API as Settings in the web app.
- **Remove Holding Local…** deletes everything the app installed, and optionally the chat
  models it downloaded (models that were already in Ollama stay).
- **Open at login** through `SMAppService`.

## Build

```
npm run build              # the web app, bundled into the Mac app
cd mac-app && ./build.sh   # build/Holding Local.app (add --universal for Intel too)
./make-dmg.sh              # build/Holding-Local-mac.dmg
```

Only the free Command Line Tools are needed (`xcode-select --install`); there's no Xcode
project. `build.sh` signs ad hoc unless `SIGN_IDENTITY` names a Developer ID certificate;
`make-dmg.sh` notarizes when the `NOTARY_*` variables are set (see the top of the script).

Logs: `~/Library/Logs/Holding Local/holding-local.log` (menu: **Show log**).

## Test

`.github/workflows/mac-app.yml` builds a universal app on a GitHub macOS runner and runs
`HoldingLocal --selftest`. The self-test does a real install into temporary folders with small
models (`all-minilm` stands in for the chat model), starts the engine, exercises the chat model
manager (list, refuse to delete the model in use, download, switch, delete), restarts, stops,
and removes everything.

## Signing and notarization

Without an Apple Developer ID, a downloaded copy is blocked by Gatekeeper. On macOS 15 and later
the person has to go to **System Settings → Privacy & Security → Open Anyway**. To make it open
with a double-click, add these repository secrets and the workflow signs and notarizes the .dmg:

| Secret | What |
|---|---|
| `MACOS_CERT_P12_BASE64` | Developer ID Application certificate with its private key, exported as .p12, then `base64 -i cert.p12` |
| `MACOS_CERT_PASSWORD` | The password you set when exporting the .p12 |
| `NOTARY_KEY_P8_BASE64` | App Store Connect API key (.p8), `base64 -i AuthKey_XXXX.p8` |
| `NOTARY_KEY_ID`, `NOTARY_ISSUER` | That key's ID and issuer ID |
