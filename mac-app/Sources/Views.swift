// The menu bar panel, the setup window, phone pairing and chat models.
import AppKit
import CoreImage.CIFilterBuiltins
import ServiceManagement
import SwiftUI

let accent = Color(red: 0.80, green: 0.42, blue: 0.36)

struct StatusLine: View {
    @ObservedObject var engine: Engine
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(text).font(.callout).foregroundColor(.secondary).lineLimit(2)
        }
    }
    var color: Color {
        switch engine.phase {
        case .running, .external: return engine.modelDownloaded ? .green : .orange
        case .starting, .installing, .checking: return .yellow
        case .failed: return .red
        default: return .gray
        }
    }
    var text: String {
        switch engine.phase {
        case .checking: return "Checking…"
        case .needsSetup: return "Not set up yet"
        case .installing: return "Setting up…"
        case .starting: return "Starting…"
        case .stopped: return "Stopped"
        case .running, .external:
            let m = engine.model ?? "the chat model"
            let base = engine.phase == .external ? "Running (started elsewhere)" : "Running"
            return engine.modelDownloaded ? "\(base) · \(m)" : "\(base) · \(m) isn't downloaded"
        case .failed(let m): return m
        }
    }
}

struct MenuView: View {
    @ObservedObject var engine: Engine
    @State private var openAtLogin = SMAppService.mainApp.status == .enabled
    let actions: AppDelegate

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "heart.fill").font(.system(size: 22)).foregroundColor(accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Holding Local").font(.headline)
                    StatusLine(engine: engine)
                }
            }
            if engine.phase == .needsSetup || engine.phase == .installing {
                Button(engine.phase == .installing ? "Show setup…" : "Set up Holding Local…") { actions.showSetup() }
                    .buttonStyle(.borderedProminent).tint(accent).controlSize(.large).frame(maxWidth: .infinity)
            } else {
                Button { actions.openHolding() } label: { Label("Open Holding", systemImage: "safari").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).tint(accent).controlSize(.large).disabled(!engine.isUp)
                HStack {
                    if engine.phase == .running {
                        Button("Stop") { engine.stop() }
                        Button("Restart") { Task { await engine.restart() } }
                    } else if engine.phase == .external {
                        Text("Close the other Holding Local window to control it here.").font(.caption).foregroundColor(.secondary)
                    } else {
                        Button("Start") { Task { await engine.start() } }.disabled(engine.phase == .starting)
                    }
                }
            }
            if engine.isUp && !engine.modelDownloaded {
                Button("Download the chat model…") { actions.showModels() }
            }
            Divider()
            Toggle("Let my phone connect", isOn: Binding(get: { engine.phoneAccess }, set: { engine.setPhoneAccess($0) }))
                .disabled(engine.phase == .external)
            Button { actions.showPhone() } label: { Label("Pair a phone…", systemImage: "qrcode") }.buttonStyle(.borderless)
            Button { actions.showModels() } label: { Label("Chat models…", systemImage: "internaldrive") }.buttonStyle(.borderless)
            Divider()
            Toggle("Open at login", isOn: Binding(get: { openAtLogin }, set: { on in
                openAtLogin = actions.setOpenAtLogin(on)
            }))
            HStack {
                Button("Show log") { actions.showLog() }.buttonStyle(.borderless)
                Spacer()
                Menu("More") {
                    Button("Remove Holding Local…") { actions.confirmRemove() }
                    Button("About Holding Local") { actions.about() }
                }.menuStyle(.borderlessButton).fixedSize()
                Button("Quit") { NSApp.terminate(nil) }.buttonStyle(.borderless)
            }.font(.callout)
        }
        .padding(16)
        .frame(width: 300)
    }
}

// MARK: setup

struct SetupView: View {
    @ObservedObject var engine: Engine
    let actions: AppDelegate

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 14) {
                Image(systemName: "heart.fill").font(.system(size: 36)).foregroundColor(accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Holding Local").font(.title2.bold())
                    Text("Free, private AI for Holding, on this Mac").foregroundColor(.secondary)
                }
            }
            if engine.phase == .needsSetup && engine.steps.isEmpty {
                intro
            } else {
                stepsList
            }
        }
        .padding(24)
        .frame(width: 480)
    }

    var intro: some View {
        let est = setupEstimate()
        let free = (try? Paths.home.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
            .volumeAvailableCapacityForImportantUsage
        return VStack(alignment: .leading, spacing: 12) {
            Text("This lets Holding's parent understand what you write, answer in her own words, speak and listen, using AI that runs entirely on this Mac. Nothing you say leaves it. No account and nothing to pay.")
                .fixedSize(horizontal: false, vertical: true)
            Text("Setting up downloads about \(est.gb) once, mostly the chat model (\(est.model), picked for this Mac's memory). On slow Wi-Fi that can take a while; you can keep using your Mac.")
                .foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            if let free, free < 25_000_000_000 {
                Label("This Mac has \(formatBytes(free)) free. Setup needs about \(est.gb) plus room to spare.", systemImage: "exclamationmark.triangle")
                    .foregroundColor(.orange).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Set up") { Task { await engine.install() } }
                    .buttonStyle(.borderedProminent).tint(accent).controlSize(.large).keyboardShortcut(.defaultAction)
            }
        }
    }

    var failure: String? {
        if case .failed(let m) = engine.phase { return m }
        return nil
    }

    var stepsList: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(engine.steps) { s in
                HStack(alignment: .top, spacing: 10) {
                    Group {
                        switch s.status {
                        case .waiting: Image(systemName: "circle").foregroundColor(.secondary)
                        case .running: ProgressView().controlSize(.small)
                        case .done: Image(systemName: "checkmark.circle.fill").foregroundColor(.green)
                        case .failed: Image(systemName: "xmark.octagon.fill").foregroundColor(.red)
                        }
                    }.frame(width: 18, height: 18)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(s.title).foregroundColor(s.status == .waiting ? .secondary : .primary)
                        if s.status == .running, let p = s.progress { ProgressView(value: p).tint(accent) }
                        if !s.detail.isEmpty && s.status != .done {
                            Text(s.detail).font(.caption).foregroundColor(s.status == .failed ? .red : .secondary)
                                .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            if let err = engine.setupError {
                Text(err).foregroundColor(.red).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Show log") { actions.showLog() }
                    Spacer()
                    Button("Try again") { Task { await engine.install() } }
                        .buttonStyle(.borderedProminent).tint(accent).keyboardShortcut(.defaultAction)
                }
            } else if engine.isUp {
                Text("All set. Holding Local starts with this app, and the heart in the menu bar shows it's running.")
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Pair a phone…") { actions.showPhone() }
                    Spacer()
                    Button("Open Holding") { actions.openHolding(); actions.closeWindow("setup") }
                        .buttonStyle(.borderedProminent).tint(accent).controlSize(.large).keyboardShortcut(.defaultAction)
                }
            } else if let m = failure {
                Text(m).foregroundColor(.red).fixedSize(horizontal: false, vertical: true)
                HStack { Button("Show log") { actions.showLog() }; Spacer(); Button("Start again") { Task { await engine.start() } } }
            } else {
                Text("You can close this window; setup keeps going in the menu bar.").font(.caption).foregroundColor(.secondary)
            }
        }
    }
}

// MARK: phone

func qrImage(_ text: String, size: CGFloat = 220) -> NSImage? {
    let f = CIFilter.qrCodeGenerator()
    f.message = Data(text.utf8)
    f.correctionLevel = "M"
    guard let out = f.outputImage else { return nil }
    let scaled = out.transformed(by: CGAffineTransform(scaleX: size / out.extent.width, y: size / out.extent.height))
    let rep = NSCIImageRep(ciImage: scaled)
    let img = NSImage(size: rep.size)
    img.addRepresentation(rep)
    return img
}

struct PhoneView: View {
    @ObservedObject var engine: Engine
    @State private var info: PairInfo?
    @State private var loading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Use it from your phone").font(.title2.bold())
            if !engine.phoneAccess {
                Text("Your phone can use this Mac's AI while both are on. Turn on phone access, then scan the code with your phone's camera.")
                    .fixedSize(horizontal: false, vertical: true)
                Button("Turn on phone access") { engine.setPhoneAccess(true); reload(after: 3) }
                    .buttonStyle(.borderedProminent).tint(accent)
                tailscaleHelp
            } else if !engine.isUp {
                Text("Start Holding Local first.").foregroundColor(.secondary)
            } else if let i = info, i.enabled, let url = i.url {
                HStack(alignment: .top, spacing: 18) {
                    if let img = qrImage(url) {
                        Image(nsImage: img).interpolation(.none).resizable().frame(width: 200, height: 200)
                            .padding(10).background(Color.white).cornerRadius(12)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Scan this with your phone's camera.")
                        Text("If the installed app asks, type this pairing code:").font(.callout).foregroundColor(.secondary)
                        Text(i.code ?? "").font(.system(size: 26, weight: .semibold, design: .monospaced)).textSelection(.enabled)
                        Text(url).font(.caption).foregroundColor(.secondary).textSelection(.enabled).lineLimit(3)
                    }
                }
                if i.secure != true {
                    Label("This is a Wi-Fi only link (plain http). Words and voice work, but phones block the camera, microphone and Add to Home Screen on it. Tailscale fixes that.", systemImage: "exclamationmark.triangle")
                        .foregroundColor(.orange).fixedSize(horizontal: false, vertical: true)
                    tailscaleHelp
                }
                HStack {
                    Button("New pairing code") { Task { await engine.restart(newToken: true); reload() } }
                        .help("Makes a new code. Phones paired before will need the new one.")
                    Spacer()
                    Button("Turn off phone access") { engine.setPhoneAccess(false); info = nil }
                }
            } else {
                if loading { ProgressView() } else {
                    Text(info?.message ?? "Phone access is starting…").foregroundColor(.secondary)
                    if let note = engine.tailscaleNote { Text(note).font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true) }
                    Button("Check again") { reload() }
                }
            }
        }
        .padding(24)
        .frame(width: 520)
        .onAppear { reload() }
    }

    var tailscaleHelp: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(Paths.tailscale == nil ? "For the best phone experience (camera, microphone, works away from home), use Tailscale. It's free:" : "Tailscale is installed. If the link above isn't https, check these once:")
                .font(.callout).fixedSize(horizontal: false, vertical: true)
            Text("1. Install Tailscale on this Mac and on your phone, and sign in to the same account on both.\n2. In the Tailscale admin console, under DNS, turn on MagicDNS and HTTPS Certificates.\n3. Turn phone access off and on again here.")
                .font(.callout).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Link("Get Tailscale", destination: URL(string: "https://tailscale.com/download")!)
                Link("Tailscale DNS settings", destination: URL(string: "https://login.tailscale.com/admin/dns")!)
            }.font(.callout)
            if let note = engine.tailscaleNote { Text(note).font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true) }
        }
    }

    func reload(after seconds: Double = 0) {
        loading = true
        Task {
            if seconds > 0 { try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9)) }
            for _ in 0..<10 {
                info = await engine.pairInfo()
                if info?.enabled == true || !engine.phoneAccess { break }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            loading = false
        }
    }
}

// MARK: chat models

struct ModelsView: View {
    @ObservedObject var engine: Engine
    @State private var list: ChatModelList?
    @State private var error: String?
    @State private var message: String?
    @State private var busy: String?
    @State private var poll: Timer?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Chat models").font(.title2.bold())
            Text("These write the parent's words. Each takes several GB, so delete the ones you don't use to get the space back.")
                .foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            if !engine.isUp {
                Text("Start Holding Local to see its chat models.").foregroundColor(.secondary)
                Button("Start") { Task { await engine.start(); load() } }
            } else if let error {
                Text(error).foregroundColor(.red).fixedSize(horizontal: false, vertical: true)
                Button("Try again") { load() }
            } else if let list {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(list.models) { m in installedRow(m) }
                        if let p = list.pull.name, list.pull.running || list.pull.error != nil { pullRow(p, list.pull) }
                        let sug = list.suggested.filter { !(list.pull.running && $0.name == list.pull.name) }
                        if !sug.isEmpty {
                            Text("Others you can download").font(.headline).padding(.top, 6)
                            ForEach(sug) { s in suggestedRow(s, pulling: list.pull.running) }
                        }
                    }.padding(.trailing, 4)
                }.frame(minHeight: 260, maxHeight: 440)
                Text("Chat models use \(formatBytes(list.total_bytes)) on this Mac." + (list.disk.free_bytes.map { " It has \(formatBytes($0)) free." } ?? ""))
                    .font(.callout).foregroundColor(.secondary)
            } else {
                ProgressView()
            }
            if let message { Text(message).font(.callout).foregroundColor(.green).fixedSize(horizontal: false, vertical: true) }
        }
        .padding(24)
        .frame(width: 520)
        .onAppear { load() }
        .onDisappear { poll?.invalidate() }
    }

    func card<C: View>(_ highlighted: Bool = false, @ViewBuilder _ c: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4, content: c)
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(highlighted ? accent : Color.secondary.opacity(0.3)))
    }

    func installedRow(_ m: ChatModelList.Model) -> some View {
        card(m.in_use) {
            HStack {
                Text(m.name).font(.body.weight(.semibold))
                if m.in_use { Text("In use").font(.caption.bold()).padding(.horizontal, 7).padding(.vertical, 2).background(accent).foregroundColor(.white).cornerRadius(8) }
                if m.kind == "embed" { Text("Memory").font(.caption).padding(.horizontal, 7).padding(.vertical, 2).background(Color.secondary.opacity(0.2)).cornerRadius(8) }
                Spacer()
                Text(formatBytes(m.bytes)).foregroundColor(.secondary)
            }
            if !m.note.isEmpty { Text(m.note).font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true) }
            if !m.deletable && !m.keep_reason.isEmpty { Text(m.keep_reason).font(.caption).foregroundColor(.secondary) }
            HStack {
                if m.kind == "chat" && !m.in_use {
                    Button("Use") { act(m.name) { try await engine.useChatModel(m.name); return "The parent now uses \(m.name)." } }
                }
                if m.deletable {
                    Button("Delete…", role: .destructive) { confirmDelete(m) }
                }
                if busy == m.name { ProgressView().controlSize(.small) }
            }.disabled(busy != nil)
        }
    }

    func pullRow(_ name: String, _ p: ChatModelList.Pull) -> some View {
        card {
            Text(name).font(.body.weight(.semibold))
            if p.running {
                if let t = p.total, t > 0 {
                    ProgressView(value: Double(p.done ?? 0) / Double(t)).tint(accent)
                    Text("Downloading · \(formatBytes(p.done)) of \(formatBytes(t))").font(.caption).foregroundColor(.secondary)
                } else {
                    ProgressView().controlSize(.small)
                    Text("Starting the download…").font(.caption).foregroundColor(.secondary)
                }
                Button("Stop") { Task { await engine.stopPull(); load() } }
            } else if let e = p.error {
                Text("Download failed: \(e)").font(.caption).foregroundColor(.red)
            }
        }
    }

    func suggestedRow(_ s: ChatModelList.Suggested, pulling: Bool) -> some View {
        card {
            HStack { Text(s.name).font(.body.weight(.semibold)); Spacer(); Text(s.download).foregroundColor(.secondary) }
            Text(s.fits ? s.note : "\(s.note) This Mac probably doesn't have enough memory for it.")
                .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            Button("Download") { act(s.name) { try await engine.pullChatModel(s.name); return nil } }.disabled(pulling || busy != nil)
        }
    }

    func confirmDelete(_ m: ChatModelList.Model) {
        let a = NSAlert()
        a.messageText = "Delete \(m.name)?"
        a.informativeText = "This frees about \(formatBytes(m.bytes)). You can download it again later."
        a.addButton(withTitle: "Delete")
        a.addButton(withTitle: "Cancel")
        a.buttons.first?.hasDestructiveAction = true
        guard a.runModal() == .alertFirstButtonReturn else { return }
        act(m.name) {
            let freed = try await engine.deleteChatModel(m.name)
            return "\(m.name) deleted. \(formatBytes(freed)) freed."
        }
    }

    func act(_ name: String, _ f: @escaping () async throws -> String?) {
        busy = name
        message = nil
        Task {
            do { message = try await f() } catch { message = nil; self.error = error.localizedDescription }
            busy = nil
            load()
        }
    }

    func load() {
        Task {
            do {
                let l = try await engine.chatModels()
                list = l
                error = nil
                poll?.invalidate()
                if l.pull.running {
                    poll = Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { _ in Task { @MainActor in load() } }
                }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
