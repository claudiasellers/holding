// Holding Widget: the parent as a small floating window on the Mac desktop.
//
// A tiny native shell around the Holding web app in widget mode (?widget=1). It lives in the
// menu bar (no Dock icon), floats above other windows or sits on the desktop like a widget,
// follows you across Spaces, and toggles with Control-Option-H. The face, voice, mirroring and
// AI are the web app's own; this file only gives it a window.
//
// Where the app comes from, in order:
//   1. the address saved with "Use a different address…" (defaults key AppURL)
//   2. Holding Local on this Mac (http://127.0.0.1:8787), when it's running: fully private
//   3. the hosted copy (https://claudiasellers.github.io/holding/)
//
// Build: ./build.sh (needs only the free Xcode Command Line Tools). No Apple developer account.

import Cocoa
import WebKit
import Carbon.HIToolbox

let bundleID = "app.holding.widget"
let localURL = URL(string: "http://127.0.0.1:8787/")!
let hostedURL = URL(string: "https://claudiasellers.github.io/holding/")!

enum WidgetSize: String, CaseIterable {
    case small, medium, large
    var size: NSSize {
        switch self {
        case .small: return NSSize(width: 260, height: 360)
        case .medium: return NSSize(width: 310, height: 440)
        case .large: return NSSize(width: 420, height: 640)
        }
    }
    var title: String { rawValue.capitalized }
}

enum Placement: String {
    case floating   // above other windows
    case desktop    // on the desktop, under other windows, like a widget
}

final class WidgetPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, NSMenuDelegate {
    static var shared: AppDelegate!

    var panel: WidgetPanel!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var hotKeyRef: EventHotKeyRef?
    var appURL: URL = hostedURL
    var source = "online copy"
    var compactSize: WidgetSize = .medium
    var showingLarge = false
    var selfTest: URL?
    let defaults = UserDefaults.standard

    // MARK: launch

    func applicationDidFinishLaunching(_ note: Notification) {
        AppDelegate.shared = self
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--selftest"), i + 1 < args.count { selfTest = URL(string: args[i + 1]) }

        compactSize = WidgetSize(rawValue: defaults.string(forKey: "Size") ?? "") ?? .medium
        buildMainMenu()
        buildPanel()
        if selfTest == nil {
            buildStatusItem()
            registerHotKey()
        }
        show()
        if let url = selfTest { load(url, source: "self-test"); runSelfTest() } else { chooseSourceAndLoad() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Opening the app again (Finder, Spotlight, login) brings the parent back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { show(); return true }

    // MARK: window

    func buildPanel() {
        let frame = NSRect(origin: .zero, size: compactSize.size)
        panel = WidgetPanel(contentRect: frame, styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        panel.title = "Holding"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 220, height: 300)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(srgbRed: 0x1c / 255, green: 0x18 / 255, blue: 0x16 / 255, alpha: 1)
                : NSColor(srgbRed: 0xf6 / 255, green: 0xef / 255, blue: 0xe6 / 255, alpha: 1)
        }
        panel.delegate = self
        applyPlacement()

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled") // right-click > Inspect Element
        let ucc = WKUserContentController()
        ucc.add(self, name: "holding")
        let marker = "window.HoldingWidgetNative = { version: '\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1")', platform: 'mac' };"
        ucc.addUserScript(WKUserScript(source: marker, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController = ucc

        webView = WKWebView(frame: frame, configuration: cfg)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground") // the window colour shows until the page paints
        webView.autoresizingMask = [.width, .height]
        // Leave the top strip (where the close button sits) for dragging the window.
        let container = NSView(frame: frame)
        container.autoresizingMask = [.width, .height]
        let titleBar: CGFloat = 26
        webView.frame = NSRect(x: 0, y: 0, width: frame.width, height: frame.height - titleBar)
        container.addSubview(webView)
        panel.contentView = container

        if !panel.setFrameUsingName("HoldingWidget") {
            if let screen = NSScreen.main?.visibleFrame {
                panel.setFrameOrigin(NSPoint(x: screen.maxX - frame.width - 24, y: screen.maxY - frame.height - 24))
            }
        }
        panel.setFrameAutosaveName("HoldingWidget")
    }

    var placement: Placement {
        get { Placement(rawValue: defaults.string(forKey: "Placement") ?? "") ?? .floating }
        set { defaults.set(newValue.rawValue, forKey: "Placement"); applyPlacement() }
    }

    func applyPlacement() {
        switch placement {
        case .floating: panel.level = .floating
        case .desktop: panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
        }
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    func hide() { panel.orderOut(nil) }

    @objc func toggle() { panel.isVisible ? hide() : show() }

    func windowShouldClose(_ sender: NSWindow) -> Bool { hide(); return false } // close = tuck away, not quit

    func resize(to size: NSSize) {
        var f = panel.frame
        let top = f.maxY
        f.size = size
        f.origin.y = top - size.height // grow downward from the top edge
        if let vis = panel.screen?.visibleFrame {
            if f.minY < vis.minY { f.origin.y = vis.minY }
            if f.maxX > vis.maxX { f.origin.x = vis.maxX - f.width }
        }
        panel.setFrame(f, display: true, animate: true)
    }

    // MARK: loading

    func chooseSourceAndLoad() {
        if let saved = defaults.string(forKey: "AppURL"), let url = URL(string: saved), url.scheme?.hasPrefix("http") == true {
            load(url, source: url.host ?? saved); return
        }
        var req = URLRequest(url: localURL.appendingPathComponent("health"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1.5)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let up = (resp as? HTTPURLResponse).map { (200..<500).contains($0.statusCode) } ?? false
            DispatchQueue.main.async {
                if up { self.load(localURL, source: "Holding Local on this Mac") } else { self.load(hostedURL, source: "online copy") }
            }
        }.resume()
    }

    func load(_ base: URL, source: String) {
        appURL = base
        self.source = source
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        var items = (comps.queryItems ?? []).filter { $0.name != "widget" }
        items.append(URLQueryItem(name: "widget", value: "1"))
        comps.queryItems = items
        webView.load(URLRequest(url: comps.url!))
        refreshMenu()
    }

    func showOffline(_ error: Error) {
        let html = """
        <!doctype html><meta charset=utf-8><meta name=color-scheme content="light dark">
        <style>body{font:14px -apple-system,system-ui;margin:0;height:100vh;display:grid;place-items:center;text-align:center;padding:16px;box-sizing:border-box;background:#f6efe6;color:#2d2622}
        @media(prefers-color-scheme:dark){body{background:#1c1816;color:#f1e8de}}button{font:inherit;padding:8px 18px;border-radius:999px;border:0;background:#b5643c;color:#fff;margin-top:10px}
        p{color:#8a7b70;font-size:12px}</style>
        <div><div style="font:18px Georgia,serif">Can't reach Holding right now.</div>
        <p>Start Holding Local on this Mac for a fully offline parent,<br>or check the internet connection.</p>
        <button onclick="webkit.messageHandlers.holding.postMessage({type:'reload'})">Try again</button></div>
        """
        webView.loadHTMLString(html, baseURL: nil)
        NSLog("Holding Widget: load failed: \(error.localizedDescription)")
    }

    // MARK: web view delegates

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        if selfTest != nil { print("SELFTEST FAIL load: \(error.localizedDescription)"); exit(1) }
        showOffline(error)
    }

    func isAppURL(_ url: URL) -> Bool {
        url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" ||
            (url.host == appURL.host && url.port == appURL.port && url.scheme == appURL.scheme)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        // tel:, sms:, helplines and any other site open in the right Mac app, not inside the widget.
        if action.targetFrame?.isMainFrame != false && !isAppURL(url) && action.navigationType != .other {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        if !["http", "https", "about", "blob", "data"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    // target=_blank links
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // Camera (on-device mirroring) and microphone (talking back), for the app's own pages only.
    // macOS still asks once, by name, the first time.
    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == appURL.host ? .grant : .deny)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK")
        a.runModal(); completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel(); p.allowsMultipleSelection = parameters.allowsMultipleSelection; p.canChooseDirectories = false
        p.begin { completionHandler($0 == .OK ? p.urls : nil) }
    }

    // Messages from the page: window.webkit.messageHandlers.holding.postMessage({...})
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "size":
            let large = (body["size"] as? String) == "large"
            if large != showingLarge {
                showingLarge = large
                resize(to: large ? WidgetSize.large.size : compactSize.size)
            }
        case "hide": hide()
        case "openFull": openFullApp()
        case "reload": chooseSourceAndLoad()
        default: break
        }
    }

    // MARK: menu bar

    func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let b = statusItem.button {
            if let img = NSImage(systemSymbolName: "heart.circle", accessibilityDescription: "Holding") {
                img.isTemplate = true
                b.image = img
            } else {
                b.title = "♡"
            }
            b.toolTip = "Holding (Control-Option-H)"
        }
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        refreshMenu()
    }

    func menuNeedsUpdate(_ menu: NSMenu) { refreshMenu() }

    func item(_ title: String, _ action: Selector?, key: String = "", on: Bool = false, mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        i.target = self
        i.state = on ? .on : .off
        return i
    }

    func refreshMenu() {
        guard let menu = statusItem?.menu else { return }
        menu.removeAllItems()
        let toggleItem = item(panel.isVisible ? "Hide Holding" : "Show Holding", #selector(toggle), key: "h", mods: [.control, .option])
        menu.addItem(toggleItem)
        menu.addItem(item("Hold me now", #selector(holdNow)))
        menu.addItem(.separator())
        menu.addItem(item("Float above windows", #selector(setFloating), on: placement == .floating))
        menu.addItem(item("Sit on the desktop", #selector(setDesktop), on: placement == .desktop))
        let sizes = NSMenuItem(title: "Size", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for s in WidgetSize.allCases {
            let i = item(s.title, #selector(setSize(_:)), on: s == compactSize)
            i.representedObject = s.rawValue
            sub.addItem(i)
        }
        sizes.submenu = sub
        menu.addItem(sizes)
        menu.addItem(.separator())
        let src = NSMenuItem(title: "Using: \(source)", action: nil, keyEquivalent: "")
        src.isEnabled = false
        menu.addItem(src)
        menu.addItem(item("Open the full app in your browser", #selector(openFullApp)))
        menu.addItem(item("Reload", #selector(reload), key: "r"))
        menu.addItem(item("Use a different address…", #selector(chooseAddress)))
        menu.addItem(.separator())
        menu.addItem(item("Open at login", #selector(toggleLogin), on: loginItemInstalled))
        menu.addItem(item("Quit Holding", #selector(quit), key: "q"))
    }

    @objc func holdNow() {
        show()
        webView.evaluateJavaScript("window.Holding && window.Holding.nav('session', { mode: 'hold' })", completionHandler: nil)
    }

    @objc func setFloating() { placement = .floating; show() }
    @objc func setDesktop() { placement = .desktop; panel.orderFront(nil) }

    @objc func setSize(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let s = WidgetSize(rawValue: raw) else { return }
        compactSize = s
        defaults.set(raw, forKey: "Size")
        if !showingLarge { resize(to: s.size) }
    }

    @objc func openFullApp() {
        var c = URLComponents(url: appURL, resolvingAgainstBaseURL: false)!
        c.queryItems = nil
        if let u = c.url { NSWorkspace.shared.open(u) }
    }

    @objc func reload() { chooseSourceAndLoad() }

    @objc func chooseAddress() {
        let a = NSAlert()
        a.messageText = "Where should the parent load from?"
        a.informativeText = "Leave empty to use Holding Local on this Mac when it's running, and the online copy otherwise. For a Mac mini on Tailscale, paste its https address."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaults.string(forKey: "AppURL") ?? ""
        field.placeholderString = "https://mac-mini.tail1234.ts.net/"
        a.accessoryView = field
        a.addButton(withTitle: "Use"); a.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn else { return }
        let v = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty { defaults.removeObject(forKey: "AppURL") }
        else if let u = URL(string: v.contains("://") ? v : "https://" + v), u.host != nil { defaults.set(u.absoluteString, forKey: "AppURL") }
        chooseSourceAndLoad()
    }

    @objc func quit() { NSApp.terminate(nil) }

    // MARK: open at login (a per-user LaunchAgent; works for unsigned apps, no admin needed)

    var loginPlist: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(bundleID).plist")
    }

    var loginItemInstalled: Bool { FileManager.default.fileExists(atPath: loginPlist.path) }

    @objc func toggleLogin() {
        if loginItemInstalled {
            try? FileManager.default.removeItem(at: loginPlist)
            return
        }
        let plist: [String: Any] = [
            "Label": bundleID,
            "ProgramArguments": ["/usr/bin/open", "-a", Bundle.main.bundlePath],
            "RunAtLoad": true,
        ]
        do {
            try FileManager.default.createDirectory(at: loginPlist.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: loginPlist)
        } catch {
            let a = NSAlert(); a.messageText = "Couldn't set Holding to open at login."; a.informativeText = error.localizedDescription; a.runModal()
        }
    }

    // MARK: global hotkey, Control-Option-H

    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { AppDelegate.shared.toggle() }
            return noErr
        }, 1, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x484C_4447), id: 1) // 'HLDG'
        RegisterEventHotKey(UInt32(kVK_ANSI_H), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    // MARK: Edit menu, so copy, paste and select-all work in the text box

    func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Hide Holding", action: #selector(toggle), keyEquivalent: "w").target = self
        appMenu.addItem(withTitle: "Quit Holding", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }

    // MARK: self-test (CI): load a URL, check the page entered widget mode, exit 0 or 1

    func runSelfTest() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { print("SELFTEST FAIL timeout"); exit(2) }
        func poll(_ n: Int) {
            let js = "JSON.stringify({ widget: document.documentElement.dataset.widget || null, screen: document.body && document.body.dataset.screen || null, native: !!window.HoldingWidgetNative })"
            webView.evaluateJavaScript(js) { result, _ in
                let s = result as? String ?? "null"
                if s.contains("\"widget\":\"1\"") && !s.contains("\"screen\":null") && s.contains("\"native\":true") {
                    print("SELFTEST PASS \(s) size=\(Int(self.panel.frame.width))x\(Int(self.panel.frame.height))")
                    // Give the size message a moment, then make sure the window followed the page.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        print("SELFTEST window \(Int(self.panel.frame.width))x\(Int(self.panel.frame.height)) large=\(self.showingLarge)")
                        exit(0)
                    }
                } else if n > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { poll(n - 1) }
                } else {
                    print("SELFTEST FAIL \(s)"); exit(1)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { poll(60) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu bar only, no Dock icon
let delegate = AppDelegate()
app.delegate = delegate
app.run()
