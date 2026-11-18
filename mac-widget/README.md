# Holding on the Mac desktop

The parent as a small window that stays on your Mac: a resting face that breathes, with **Hold me** one click away. They speak first, so you never have to type or say anything. It lives in the menu bar (the heart), not the Dock.

## Install (one line, no Apple license)

Open **Terminal** and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/claudiasellers/holding/main/mac-widget/install.sh | bash
```

That downloads the latest build, puts **Holding Widget** in Applications and opens it. There's no "unidentified developer" warning, because files fetched this way aren't quarantined and the app carries a free local (ad-hoc) signature. Run the same line again to update.

If there's no download yet, or you'd rather build it yourself, the installer builds it on your Mac with Apple's free Command Line Tools (it offers to install them):

```bash
curl -fsSL https://raw.githubusercontent.com/claudiasellers/holding/main/mac-widget/install.sh | bash -s -- --from-source
```

Remove it with `… | bash -s -- --uninstall`.

## Using it

| | |
|---|---|
| **Control-Option-H** | Show or hide the parent, from any app |
| **Hold me** | The parent starts talking; type, tap a feeling or press Mic only if you want to |
| Menu bar heart → **Float above windows** | Always on top, on every Space and over full-screen apps |
| Menu bar heart → **Sit on the desktop** | Behind your windows, like a widget; shows when you clear the desktop |
| Menu bar heart → **Size** | Small, Medium or Large. You can also drag the window's edges. Choosing or editing a parent opens it bigger, then it shrinks back |
| Menu bar heart → **Open at login** | Start with the Mac |
| Close button | Tucks the parent away. Quit from the menu bar heart |

Drag the strip along the top to move it. The position and size are remembered.

## Where the parent comes from

1. **Holding Local on this Mac**, if it's running (`http://127.0.0.1:8787`). Nothing leaves the computer, and you get the local model and voice.
2. Otherwise the **online copy** on GitHub Pages. The app still runs in the widget, and your conversations stay in the widget's own storage on this Mac.
3. **Use a different address…** in the menu points it anywhere else, for example a Mac mini's Tailscale address (`https://mac-mini.tail1234.ts.net/`). Leave the box empty to go back to automatic.

The menu shows which one is in use. Each address keeps its own chosen parent, settings and saved lines, the same way two browsers would.

Camera mirroring and the microphone work in the widget. macOS asks once the first time each is used.

## How it's built

`Sources/main.swift` is a single-file AppKit app: an `NSPanel` holding a `WKWebView` that loads the Holding web app with `?widget=1`. Widget mode (`src/ui/widget.js`, `src/ui/widget.css`) adds the small resting screen and a compact session layout, and asks the window to grow for the picker and settings through `window.webkit.messageHandlers.holding`. Everything else, the face, mirroring, voice and AI, is the web app's own, so the widget never falls behind it.

```bash
./build.sh               # build/Holding Widget.app for this Mac
./build.sh --universal   # Apple Silicon + Intel, as CI ships it
"build/Holding Widget.app/Contents/MacOS/HoldingWidget" --selftest http://127.0.0.1:8787/
```

`.github/workflows/mac-widget.yml` builds it on a macOS runner, runs the self-test against the built web app, and on `main` attaches `Holding-Widget-mac.zip` to the `latest` release that the installer downloads.

### Why not a WidgetKit widget?

Apple's Notification Center and desktop widgets are snapshots: they can't play the voice, animate the face, use the camera or take typing, and they have to ship inside a signed app built in Xcode. A small native window does all of that and installs without a developer account.
