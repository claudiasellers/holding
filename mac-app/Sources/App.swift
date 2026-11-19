// Holding Local for Mac: a menu bar app that installs, runs and watches Holding Local,
// the free private AI for the Holding app, so nobody needs the repo or a terminal.
//
//   HoldingLocal              the app (menu bar heart; setup window on first run)
//   HoldingLocal --selftest   headless end-to-end check used by CI (see SelfTest below)
// Built with swiftc -parse-as-library (see build.sh); no Xcode project needed.
import AppKit
import Combine
import ServiceManagement
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let engine = Engine()
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private var windows: [String: NSWindow] = [:]
    private var bag = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ note: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let b = statusItem.button {
            b.action = #selector(togglePopover(_:))
            b.target = self
        }
        setIcon(running: false)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: MenuView(engine: engine, actions: self))
        engine.$phase.receive(on: RunLoop.main).sink { [weak self] p in
            self?.setIcon(running: p == .running || p == .external)
        }.store(in: &bag)
        Task {
            await engine.bootstrap()
            if engine.phase == .needsSetup { showSetup() }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if engine.phase == .needsSetup || engine.phase == .installing { showSetup() } else { showPopover() }
        return false
    }

    func applicationWillTerminate(_ note: Notification) {
        engine.shutdown()
    }

    private func setIcon(running: Bool) {
        let img = NSImage(systemSymbolName: running ? "heart.fill" : "heart", accessibilityDescription: "Holding Local")
        img?.isTemplate = true
        statusItem?.button?.image = img
        statusItem?.button?.toolTip = running ? "Holding Local is running" : "Holding Local"
    }

    @objc func togglePopover(_ sender: Any?) {
        if popover.isShown { popover.performClose(sender) } else { showPopover() }
    }

    func showPopover() {
        guard let b = statusItem.button else { return }
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY)
    }

    // MARK: windows

    func showWindow<V: View>(_ id: String, _ title: String, _ view: V) {
        popover.performClose(nil)
        if let w = windows[id] {
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let host = NSHostingController(rootView: view)
        host.sizingOptions = .preferredContentSize
        let w = NSWindow(contentViewController: host)
        w.title = title
        w.styleMask = [.titled, .closable, .miniaturizable]
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.center()
        windows[id] = w
        // A Dock icon while a window is open, so it's easy to find again.
        NSApp.setActivationPolicy(.regular)
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ note: Notification) {
        guard let w = note.object as? NSWindow else { return }
        windows = windows.filter { $0.value !== w }
        if windows.isEmpty { NSApp.setActivationPolicy(.accessory) }
    }

    func closeWindow(_ id: String) { windows[id]?.close() }

    func showSetup() { showWindow("setup", "Set up Holding Local", SetupView(engine: engine, actions: self)) }
    func showPhone() { showWindow("phone", "Pair a phone", PhoneView(engine: engine)) }
    func showModels() { showWindow("models", "Chat models", ModelsView(engine: engine)) }

    // MARK: actions

    func openHolding() {
        popover.performClose(nil)
        // ?local=1 tells the web app to use this Mac's AI, voice and listening right away.
        NSWorkspace.shared.open(URL(string: "\(Pins.local.absoluteString)/?local=1")!)
    }

    func showLog() {
        NSWorkspace.shared.open(engine.log.url)
    }

    func setOpenAtLogin(_ on: Bool) -> Bool {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            let a = NSAlert()
            a.messageText = on ? "Couldn't turn on Open at login" : "Couldn't turn off Open at login"
            a.informativeText = "\(error.localizedDescription)\n\nYou can add Holding Local yourself in System Settings > General > Login Items."
            a.runModal()
        }
        return SMAppService.mainApp.status == .enabled
    }

    func about() {
        popover.performClose(nil)
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [
            .credits: NSAttributedString(string: "Free, private AI for Holding that runs on this Mac.\nOllama \(Pins.ollamaVersion) · Engine in \(Paths.engine.path)"),
        ])
    }

    func confirmRemove() {
        popover.performClose(nil)
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = "Remove Holding Local from this Mac?"
        a.informativeText = "This stops it and deletes its engine, voices, settings and pairing code. Phones paired with this Mac will stop working. Chat models that were already on this Mac before Holding Local stay."
        a.addButton(withTitle: "Remove, including chat models")
        a.addButton(withTitle: "Remove, keep chat models")
        a.addButton(withTitle: "Cancel")
        a.buttons.first?.hasDestructiveAction = true
        let r = a.runModal()
        guard r != .alertThirdButtonReturn else { return }
        _ = setOpenAtLoginQuietly(false)
        Task {
            let notes = await engine.removeEverything(models: r == .alertFirstButtonReturn)
            engine.log.line(notes.joined(separator: "\n"))
            let done = NSAlert()
            done.messageText = "Holding Local is removed"
            done.informativeText = "To finish, drag Holding Local from Applications to the Trash."
            done.runModal()
            NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
            NSApp.terminate(nil)
        }
    }

    private func setOpenAtLoginQuietly(_ on: Bool) -> Bool {
        if !on { try? SMAppService.mainApp.unregister() }
        return SMAppService.mainApp.status == .enabled
    }
}

// MARK: self-test (CI): the real install and engine, headless, with small models.

enum SelfTest {
    @MainActor
    static func run() async -> Bool {
        let e = Engine()
        func check(_ ok: Bool, _ what: String) throws {
            print(ok ? "ok   \(what)" : "FAIL \(what)")
            if !ok { throw AppError(what) }
        }
        do {
            print("Self-test in \(Paths.support.path)")
            // Setup with a tiny model (an embedding model stands in for the chat model).
            await e.install(model: "all-minilm")
            for s in e.steps { print("     step \(s.id): \(s.status)") }
            try check(e.setupError == nil, "setup finished \(e.setupError ?? "")")
            try check(e.phase == .running, "engine running after setup (\(e.phase))")
            try check(e.model == "all-minilm" && e.modelDownloaded, "health reports the chosen model as downloaded")
            // A second setup (say after reinstalling the app) finds everything and downloads nothing big.
            let again = SetupPlan.scan()
            print("     plan: \(again.summary)")
            try check(again.model == "all-minilm" && again.haveModel, "setup plan finds the chat model already downloaded")
            try check(again.found.contains { $0.what == "the memory model" } && again.found.contains { $0.what == "the parent's voice" },
                      "setup plan finds the memory model and the voice")
            try check(again.downloadHigh < 0.5, "setup plan has almost nothing left to download (\(again.downloadText))")
            let (page, _) = try await URLSession.shared.data(from: Pins.local)
            try check(String(decoding: page, as: UTF8.self).contains("<"), "serves the web app")

            var list = try await e.chatModels()
            try check(list.models.contains { $0.name.hasPrefix("all-minilm") && $0.in_use && !$0.deletable }, "lists the model in use, not deletable")
            try check(list.models.contains { $0.name.hasPrefix("nomic-embed-text") && $0.deletable }, "lists the memory model as deletable")
            do { _ = try await e.deleteChatModel("all-minilm"); try check(false, "refuses to delete the model in use") }
            catch let err as AppError where err.message.contains("Pick another") { try check(true, "refuses to delete the model in use") }

            // Download, switch to, and delete another model through the manager.
            try await e.pullChatModel("all-minilm:33m")
            for _ in 0..<600 {
                list = try await e.chatModels()
                if !list.pull.running { break }
                try await Task.sleep(nanoseconds: 500_000_000)
            }
            try check(list.pull.status == "success", "pull finished (\(list.pull.status ?? "?") \(list.pull.error ?? ""))")
            try await e.useChatModel("all-minilm:33m")
            try check(e.model == "all-minilm:33m", "switched to the new model")
            let freed = try await e.deleteChatModel("all-minilm:latest")
            try check(freed > 0, "deleted the old model, \(formatBytes(freed)) freed")
            list = try await e.chatModels()
            try check(!list.models.contains { $0.name == "all-minilm:latest" }, "old model gone from the list")

            let pair = await e.pairInfo()
            try check(pair?.enabled == false, "pairing is off until phone access is turned on")
            await e.restart()
            try check(e.phase == .running, "restarts")
            e.stop()
            try check(!(await e.healthOK()), "stops")
            let notes = await e.removeEverything(models: true)
            print(notes.map { "     \($0)" }.joined(separator: "\n"))
            try check(!Paths.fm.fileExists(atPath: Paths.support.path), "remove deletes everything it installed")
            return true
        } catch {
            print("Self-test failed: \(error.localizedDescription). Log: \(e.log.url.path)")
            if let s = try? String(contentsOf: e.log.url, encoding: .utf8) { print(s.suffix(6000)) }
            e.shutdown()
            return false
        }
    }
}

@main
struct HoldingLocalMain {
    @MainActor
    static func main() {
        if CommandLine.arguments.contains("--selftest") {
            // It installs and then removes everything, so it only runs in folders made for it.
            guard Paths.env["HOLDING_APP_HOME"] != nil, Paths.env["HOLDING_LOCAL_HOME"] != nil else {
                print("Set HOLDING_APP_HOME and HOLDING_LOCAL_HOME to empty folders to run the self-test.")
                exit(2)
            }
            Task { @MainActor in
                let ok = await SelfTest.run()
                print(ok ? "SELFTEST PASSED" : "SELFTEST FAILED")
                exit(ok ? 0 : 1)
            }
            dispatchMain()
        }
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}
