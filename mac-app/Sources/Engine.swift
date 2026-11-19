// Installs, starts and watches Holding Local (the Python engine) and Ollama.
//
// Layout, all under ~/Library/Application Support/Holding Local:
//   engine/          a copy of the engine shipped in the app, plus its .venv (made by the bundled uv)
//   python/, cache/  uv's own Python and download cache
//   ollama/          Ollama's standalone build, only if Ollama isn't already on this Mac
//   installed.json   what setup finished with, and which chat models this app downloaded
// The engine keeps its settings, voices and pairing code in ~/.holding-local, like the
// terminal version, and Ollama keeps models in ~/.ollama, so nothing is downloaded twice.
import AppKit
import Foundation

struct Step: Identifiable, Equatable {
    enum Status: Equatable { case waiting, running, done, failed }
    let id: String
    var title: String
    var detail = ""
    var progress: Double?  // 0...1, or nil when we can't tell
    var status: Status = .waiting
}

struct PairInfo: Decodable {
    let enabled: Bool
    let url: String?
    let code: String?
    let secure: Bool?
    let message: String?
}

struct ChatModelList: Decodable {
    struct Model: Decodable, Identifiable {
        var id: String { name }
        let name: String
        let bytes: Int64
        let parameter_size: String?
        let kind: String
        let in_use: Bool
        let note: String
        let deletable: Bool
        let keep_reason: String
    }
    struct Suggested: Decodable, Identifiable {
        var id: String { name }
        let name: String
        let download: String
        let note: String
        let fits: Bool
    }
    struct Disk: Decodable { let free_bytes: Int64? }
    struct Pull: Decodable {
        let name: String?
        let running: Bool
        let done: Int64?
        let total: Int64?
        let status: String?
        let error: String?
    }
    let models: [Model]
    let selected: String
    let suggested: [Suggested]
    let total_bytes: Int64
    let disk: Disk
    let pull: Pull
}

struct Installed: Codable {
    var version: String
    var model: String?
    var downloadedModels: [String]
}

@MainActor
final class Engine: ObservableObject {
    enum Phase: Equatable {
        case checking, needsSetup, installing, stopped, starting, running
        case external          // something else (the terminal version) already serves :8787
        case failed(String)
    }

    @Published var phase: Phase = .checking
    @Published var steps: [Step] = []
    @Published var model: String?
    @Published var modelDownloaded = true
    @Published var ollamaUp = false
    @Published var phoneAccess: Bool = UserDefaults.standard.bool(forKey: "phoneAccess")
    @Published var tailscaleNote: String?
    @Published var setupError: String?

    let log = LogFile(name: "holding-local.log")
    private var engineProc: ChildProcess?
    private var ollamaProc: ChildProcess?
    private var healthTimer: Timer?
    private var stopping = false

    var isUp: Bool { phase == .running || phase == .external }

    // MARK: lifecycle

    func bootstrap() async {
        log.line("Holding Local app \(Paths.appVersion) starting")
        if await healthOK() { phase = .external; startHealthTimer(); return }
        guard let inst = readInstalled(), Paths.fm.isExecutableFile(atPath: Paths.holdingLocal.path) else {
            phase = .needsSetup
            return
        }
        if inst.version != Paths.appVersion {
            // A newer app: bring the engine copy up to date (quick: uv reuses what it has).
            phase = .starting
            do {
                _ = try prepareEngine()
                try await uvSync { _ in }
                var i = inst; i.version = Paths.appVersion; writeInstalled(i)
            } catch {
                phase = .failed("Couldn't update the engine: \(error.localizedDescription)")
                return
            }
        }
        await start()
    }

    /// The whole first-run setup. `model` overrides the automatic pick (the self-test uses a tiny one).
    func install(model override: String? = nil) async {
        setupError = nil
        phase = .installing
        steps = [
            Step(id: "engine", title: "Voice and listening engine", detail: "About 400 MB, once"),
            Step(id: "ollama", title: "Ollama, which runs the chat model"),
            Step(id: "voice", title: "The parent's voice"),
            Step(id: "model", title: "Chat model"),
            Step(id: "memory", title: "Memory model (for your private notes)"),
            Step(id: "finish", title: "Getting ready"),
        ]
        stopEngine()
        do {
            begin("engine")
            _ = try prepareEngine()
            try await uvSync { [weak self] line in self?.detail("engine", Self.uvDetail(line)) }
            finishStep("engine")

            begin("ollama")
            if await ollamaReachable() || SetupPlan.existingOllama() != nil || Paths.fm.isExecutableFile(atPath: Paths.ollama.path) {
                retitle("ollama", "Ollama · already on this Mac")
            }
            try await ensureOllama { [weak self] done, total in
                self?.progress("ollama", done: done, total: total, verb: "Downloading")
            }
            finishStep("ollama")
            let before = Set(await ollamaModelNames())

            var planned: String?
            var failure: String?
            var args = ["setup", "--json", "--no-start"]
            if let override { args += ["--model", override] }
            let code = try await runTool(Paths.holdingLocal, args, cwd: Paths.engine, log: log) { [weak self] line in
                guard let self, line.hasPrefix("{"),
                      let obj = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
                      let ev = obj["event"] as? String else { return }
                switch ev {
                case "plan":
                    planned = obj["model"] as? String
                    if let m = planned {
                        let size = (obj["download"] as? String).map { ", about \($0)" } ?? ""
                        self.retitle("model", (obj["have"] as? Bool) == true
                                     ? "Chat model: \(m) · already on this Mac" : "Chat model: \(m)\(size)")
                    }
                case "step":
                    let map = ["voice": "voice", "model": "model", "embed": "memory", "listening": "finish", "warm": "finish"]
                    if let id = map[obj["id"] as? String ?? ""] {
                        self.begin(id)
                        // Already downloaded by an earlier install or by Ollama: say so instead of downloading.
                        if (obj["have"] as? Bool) == true, let t = self.steps.first(where: { $0.id == id })?.title,
                           !t.hasSuffix("already on this Mac") {
                            self.retitle(id, "\(t) · already on this Mac")
                        }
                    }
                case "progress":
                    let done = (obj["done"] as? NSNumber)?.int64Value ?? 0
                    let total = (obj["total"] as? NSNumber)?.int64Value ?? 0
                    if let id = self.steps.first(where: { $0.status == .running })?.id {
                        self.progress(id, done: done, total: total, verb: "Downloading")
                    }
                case "error":
                    failure = obj["message"] as? String ?? "Setup stopped."
                default: break
                }
            }
            if let failure { throw AppError(failure) }
            if code != 0 { throw AppError("Setup stopped (code \(code)). The log has the details.") }
            for i in steps.indices where steps[i].status != .done { steps[i].status = .done; steps[i].progress = nil }

            let after = Set(await ollamaModelNames())
            var inst = readInstalled() ?? Installed(version: Paths.appVersion, model: nil, downloadedModels: [])
            inst.version = Paths.appVersion
            inst.model = planned
            inst.downloadedModels = Array(Set(inst.downloadedModels).union(after.subtracting(before))).sorted()
            writeInstalled(inst)
            log.line("Setup finished with \(planned ?? "?")")
            await start()
        } catch {
            let msg = error.localizedDescription
            log.line("Setup failed: \(msg)")
            if let i = steps.firstIndex(where: { $0.status == .running }) { steps[i].status = .failed; steps[i].detail = msg }
            setupError = msg
            phase = .needsSetup
        }
    }

    func start(newToken: Bool = false) async {
        if await healthOK() {
            if engineProc?.running != true { phase = .external }
            startHealthTimer()
            return
        }
        phase = .starting
        do {
            try await ensureOllama { _, _ in }
            var args = ["start", "--no-browser", "--port", "\(Pins.port)"]
            if Paths.fm.fileExists(atPath: Paths.bundledWebApp.appendingPathComponent("index.html").path) {
                args += ["--app-dir", Paths.bundledWebApp.path]
            }
            if phoneAccess { args += Paths.tailscale != nil ? ["--tailscale", "--lan"] : ["--lan"] }
            if newToken { args.append("--new-token") }
            tailscaleNote = nil
            stopping = false
            let p = try ChildProcess(Paths.holdingLocal, args, cwd: Paths.engine, log: log)
            engineProc = p
            Task { [weak self] in
                for await line in p.lines {
                    if line.contains("Tailscale") || line.contains("tailnet") { self?.tailscaleNote = line.trimmingCharacters(in: .whitespaces) }
                }
                let code = await p.wait()
                guard let self, self.engineProc === p else { return }
                self.engineProc = nil
                if !self.stopping {
                    self.log.line("Engine exited with code \(code)")
                    self.phase = .failed("Holding Local stopped unexpectedly. Show the log for details, or start it again.")
                }
            }
            for _ in 0..<120 {
                if await healthOK() { break }
                if !p.running { return }  // the watcher above reports it
                try await Task.sleep(nanoseconds: 500_000_000)
            }
            if await healthOK() {
                phase = .running
                startHealthTimer()
            } else {
                p.stop()
                phase = .failed("Holding Local didn't start in time. Show the log for details.")
            }
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func stop() {
        stopEngine()
        phase = .stopped
    }

    func restart(newToken: Bool = false) async {
        stopEngine()
        await start(newToken: newToken)
    }

    func setPhoneAccess(_ on: Bool) {
        phoneAccess = on
        UserDefaults.standard.set(on, forKey: "phoneAccess")
        if phase == .running { Task { await restart() } }
    }

    /// Called when the app quits: nothing of ours keeps running in the background.
    func shutdown() {
        healthTimer?.invalidate()
        stopEngine()
        ollamaProc?.stop(grace: 3)
        ollamaProc = nil
    }

    private func stopEngine() {
        stopping = true
        healthTimer?.invalidate()
        engineProc?.stop()
        engineProc = nil
    }

    // MARK: health

    func healthOK() async -> Bool {
        guard let data = try? await fetchJSON(Pins.local.appendingPathComponent("health"), timeout: 2),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        let llm = obj["llm"] as? [String: Any]
        model = llm?["model"] as? String
        modelDownloaded = llm?["downloaded"] as? Bool ?? true
        ollamaUp = llm?["reachable"] as? Bool ?? false
        return true
    }

    private func startHealthTimer() {
        healthTimer?.invalidate()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.isUp else { return }
                if !(await self.healthOK()), self.phase == .external { self.phase = .stopped }
            }
        }
    }

    func pairInfo() async -> PairInfo? {
        guard let d = try? await fetchJSON(Pins.local.appendingPathComponent("v1/pair")) else { return nil }
        return try? JSONDecoder().decode(PairInfo.self, from: d)
    }

    // MARK: chat models (through the engine's /v1/chat-models)

    func chatModels() async throws -> ChatModelList {
        let d = try await fetchJSON(Pins.local.appendingPathComponent("v1/chat-models"))
        return try JSONDecoder().decode(ChatModelList.self, from: d)
    }

    func useChatModel(_ name: String) async throws {
        _ = try await fetchJSON(Pins.local.appendingPathComponent("v1/chat-models/select"), method: "POST", body: ["name": name])
        _ = await healthOK()
    }

    func pullChatModel(_ name: String) async throws {
        _ = try await fetchJSON(Pins.local.appendingPathComponent("v1/chat-models/pull"), method: "POST", body: ["name": name])
        var inst = readInstalled() ?? Installed(version: Paths.appVersion, model: nil, downloadedModels: [])
        if !inst.downloadedModels.contains(name) { inst.downloadedModels.append(name); writeInstalled(inst) }
    }

    func stopPull() async {
        _ = try? await fetchJSON(Pins.local.appendingPathComponent("v1/chat-models/pull"), method: "DELETE")
    }

    /// Returns the space freed.
    func deleteChatModel(_ name: String) async throws -> Int64 {
        let enc = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
        let url = URL(string: "\(Pins.local.absoluteString)/v1/chat-models/\(enc)")!
        let d = try await fetchJSON(url, method: "DELETE", timeout: 60)
        let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
        return (obj?["freed_bytes"] as? NSNumber)?.int64Value ?? 0
    }

    // MARK: removing everything

    /// Stops everything and deletes what this app put on the Mac. Chat models are deleted
    /// only if this app downloaded them (and `models` is true); ones that were already in
    /// Ollama stay.
    func removeEverything(models: Bool) async -> [String] {
        var notes: [String] = []
        let inst = readInstalled()
        if models, let names = inst?.downloadedModels, !names.isEmpty {
            // Only talk to an Ollama that's here already; never download one just to delete.
            if !(await ollamaReachable()), Paths.fm.isExecutableFile(atPath: Paths.ollama.path) {
                try? await ensureOllama { _, _ in }
            }
            for n in names {
                var r = URLRequest(url: Pins.ollama.appendingPathComponent("api/delete"))
                r.httpMethod = "DELETE"
                r.httpBody = try? JSONSerialization.data(withJSONObject: ["model": n, "name": n])
                r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                if let (_, resp) = try? await URLSession.shared.data(for: r), (resp as? HTTPURLResponse)?.statusCode == 200 {
                    notes.append("Deleted chat model \(n)")
                }
            }
        }
        shutdown()
        for u in [Paths.support, Paths.engineHome, Paths.logs] where Paths.fm.fileExists(atPath: u.path) {
            do { try Paths.fm.removeItem(at: u); notes.append("Removed \(u.path)") } catch { notes.append("Couldn't remove \(u.path): \(error.localizedDescription)") }
        }
        UserDefaults.standard.removePersistentDomain(forName: Bundle.main.bundleIdentifier ?? "app.holding.local")
        phase = .needsSetup
        return notes
    }

    // MARK: install pieces

    /// Copies the engine shipped inside the app to Application Support (the app bundle is
    /// read-only once signed). Keeps the existing .venv so updates are quick.
    @discardableResult
    func prepareEngine() throws -> Bool {
        let stamp = Paths.engine.appendingPathComponent(".app-version")
        if (try? String(contentsOf: stamp, encoding: .utf8)) == Paths.appVersion,
           Paths.fm.fileExists(atPath: Paths.engine.appendingPathComponent("pyproject.toml").path) { return false }
        guard Paths.fm.fileExists(atPath: Paths.bundledEngine.path) else { throw AppError("This copy of the app is missing its engine. Download it again.") }
        try Paths.fm.createDirectory(at: Paths.engine, withIntermediateDirectories: true)
        for item in try Paths.fm.contentsOfDirectory(atPath: Paths.bundledEngine.path) {
            let dest = Paths.engine.appendingPathComponent(item)
            try? Paths.fm.removeItem(at: dest)
            try Paths.fm.copyItem(at: Paths.bundledEngine.appendingPathComponent(item), to: dest)
        }
        try Paths.appVersion.write(to: stamp, atomically: true, encoding: .utf8)
        return true
    }

    func uvSync(onLine: (String) -> Void) async throws {
        guard Paths.fm.isExecutableFile(atPath: Paths.bundledUV.path) else { throw AppError("This copy of the app is missing uv. Download it again.") }
        let code = try await runTool(Paths.bundledUV, ["sync", "--frozen", "--extra", "stt", "--inexact", "--no-progress"],
                                     cwd: Paths.engine, log: log, onLine: onLine)
        if code != 0 { throw AppError("Couldn't set up the voice engine (uv exited with \(code)). Check the internet connection and try again.") }
    }

    nonisolated static func uvDetail(_ line: String) -> String {
        let t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("Downloading") || t.hasPrefix("Installed") || t.hasPrefix("Using") || t.hasPrefix("Prepared") { return t }
        return ""
    }

    func ollamaReachable() async -> Bool {
        var r = URLRequest(url: Pins.ollama.appendingPathComponent("api/version"), timeoutInterval: 2)
        r.httpMethod = "GET"
        guard let (_, resp) = try? await URLSession.shared.data(for: r) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }

    func ollamaModelNames() async -> [String] {
        guard let (d, _) = try? await URLSession.shared.data(from: Pins.ollama.appendingPathComponent("api/tags")),
              let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let ms = obj["models"] as? [[String: Any]] else { return [] }
        return ms.compactMap { $0["name"] as? String }
    }

    /// Uses an Ollama that's already running or installed; otherwise downloads the pinned
    /// standalone build into our folder and runs `ollama serve` ourselves (and stops it on quit).
    func ensureOllama(progress: @escaping (Int64, Int64) -> Void) async throws {
        if await ollamaReachable() { return }
        if ollamaProc?.running == true { try await waitForOllama(); return }
        let apps = ["/Applications/Ollama.app", Paths.home.appendingPathComponent("Applications/Ollama.app").path]
        let ownOnly = ProcessInfo.processInfo.environment["HOLDING_OWN_OLLAMA"] != nil
        if !ownOnly, let app = apps.first(where: { Paths.fm.fileExists(atPath: $0) }) {
            log.line("Starting the Ollama app at \(app)")
            NSWorkspace.shared.open(URL(fileURLWithPath: app))
            if (try? await waitForOllama(seconds: 30)) != nil { return }
        }
        // An ollama command from Homebrew or the install script: run it rather than download another.
        let cli = ownOnly ? nil : SetupPlan.ollamaCLI()
        if cli == nil, !Paths.fm.isExecutableFile(atPath: Paths.ollama.path) {
            let tgz = Paths.support.appendingPathComponent("downloads/ollama-darwin.tgz")
            log.line("Downloading Ollama \(Pins.ollamaVersion)")
            _ = try await Downloader.fetch(Pins.ollamaURL, to: tgz) { @Sendable done, total in
                Task { @MainActor in progress(done, total) }
            }
            let sum = try sha256(of: tgz)
            guard sum == Pins.ollamaSHA256 else {
                try? Paths.fm.removeItem(at: tgz)
                throw AppError("The Ollama download didn't match its checksum, so it wasn't used. Try again.")
            }
            let tmp = Paths.support.appendingPathComponent("ollama.partial", isDirectory: true)
            try? Paths.fm.removeItem(at: tmp)
            try Paths.fm.createDirectory(at: tmp, withIntermediateDirectories: true)
            let code = try await runTool(URL(fileURLWithPath: "/usr/bin/tar"), ["-xzf", tgz.path, "-C", tmp.path], log: log)
            guard code == 0, Paths.fm.isExecutableFile(atPath: tmp.appendingPathComponent("ollama").path) else {
                throw AppError("Couldn't unpack Ollama (tar exited with \(code)).")
            }
            try? Paths.fm.removeItem(at: Paths.ollamaDir)
            try Paths.fm.moveItem(at: tmp, to: Paths.ollamaDir)
            try? Paths.fm.removeItem(at: tgz)
        }
        let bin = cli.map { URL(fileURLWithPath: $0) } ?? Paths.ollama
        log.line("Starting \(bin.path) serve")
        ollamaProc = try ChildProcess(bin, ["serve"], cwd: cli == nil ? Paths.ollamaDir : Paths.home, log: LogFile(name: "ollama.log"))
        if let p = ollamaProc { Task { for await _ in p.lines {} } }  // drain; it's in ollama.log
        try await waitForOllama()
    }

    private func waitForOllama(seconds: Int = 60) async throws {
        for _ in 0..<(seconds * 2) {
            if await ollamaReachable() { return }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        throw AppError("Ollama didn't start. Show the log for details.")
    }

    // MARK: step bookkeeping

    private func idx(_ id: String) -> Int? { steps.firstIndex { $0.id == id } }

    private func begin(_ id: String) {
        for i in steps.indices where steps[i].status == .running && steps[i].id != id {
            steps[i].status = .done; steps[i].progress = nil
        }
        if let i = idx(id) { steps[i].status = .running; steps[i].progress = nil; if id != "engine" { steps[i].detail = "" } }
    }

    private func finishStep(_ id: String) {
        if let i = idx(id) { steps[i].status = .done; steps[i].progress = nil; steps[i].detail = "" }
    }

    private func detail(_ id: String, _ s: String) {
        guard !s.isEmpty, let i = idx(id) else { return }
        steps[i].detail = s
    }

    private func retitle(_ id: String, _ t: String) {
        if let i = idx(id) { steps[i].title = t }
    }

    private func progress(_ id: String, done: Int64, total: Int64, verb: String) {
        guard let i = idx(id) else { return }
        steps[i].status = .running
        if total > 0 {
            steps[i].progress = min(1, Double(done) / Double(total))
            steps[i].detail = "\(verb) · \(formatBytes(done)) of \(formatBytes(total))"
        } else {
            steps[i].progress = nil
            steps[i].detail = "\(verb) · \(formatBytes(done))"
        }
    }

    // MARK: installed.json

    func readInstalled() -> Installed? {
        guard let d = try? Data(contentsOf: Paths.installed) else { return nil }
        return try? JSONDecoder().decode(Installed.self, from: d)
    }

    func writeInstalled(_ i: Installed) {
        try? Paths.fm.createDirectory(at: Paths.support, withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(i) { try? d.write(to: Paths.installed, options: .atomic) }
    }
}

/// What first-run setup will download on this Mac, after looking for what's already here:
/// chat models in ~/.ollama (from Ollama, the terminal install or another app), the
/// engine's settings and voice in ~/.holding-local, and an Ollama to run them with.
/// It mirrors the engine's own choices (holding_local/setup.py and catalog.py), so the
/// welcome screen says what setup will really do. Reads files only; no network.
struct SetupPlan {
    struct Found: Hashable { let what: String; let bytes: Int64 }

    var model = ""                 // the chat model setup will use
    var modelReason = ""           // why that one
    var haveModel = false          // already downloaded
    var found: [Found] = []        // things setup reuses
    var downloadLow: Double = 0    // GB still to download
    var downloadHigh: Double = 0

    var nothingFound: Bool { found.isEmpty }
    var downloadText: String {
        let lo = downloadLow, hi = downloadHigh
        if hi < 0.95 { return "about \(max(1, Int((hi * 1000 / 50).rounded()) * 50)) MB" }
        let r = { (x: Double) in String(format: "%.0f", max(1, x.rounded())) }
        return r(lo) == r(hi) ? "about \(r(hi)) GB" : "about \(r(lo))-\(r(hi)) GB"
    }

    /// The engine's chat model tiers (catalog.LLM_TIERS): tag, memory needed, download in GB.
    static let tiers: [(tag: String, minGB: Double, low: Double, high: Double)] = [
        ("qwen3.5:4b", 0, 3.3, 4.0), ("gemma4:e4b", 15, 6.6, 9.5), ("gemma4:12b", 30, 7.7, 8.0), ("gemma4:26b", 46, 16, 19),
    ]
    static let embedTag = "nomic-embed-text"

    static func same(_ a: String, _ b: String) -> Bool {
        let n = { (x: String) in x.contains(":") ? x : x + ":latest" }
        return n(a) == n(b)
    }

    static var ollamaModelsDir: URL {
        if let o = Paths.env["OLLAMA_MODELS"], !o.isEmpty { return URL(fileURLWithPath: o, isDirectory: true) }
        return Paths.home.appendingPathComponent(".ollama/models", isDirectory: true)
    }

    /// Models Ollama has on disk, read from its manifests (works while Ollama is stopped).
    static func ollamaModelsOnDisk() -> [String: Int64] {
        let root = ollamaModelsDir.appendingPathComponent("manifests", isDirectory: true)
        var out: [String: Int64] = [:]
        guard let walk = Paths.fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else { return out }
        for case let f as URL in walk {
            // manifests/<host>/<namespace>/<name>/<tag>
            let parts = Array(f.pathComponents.suffix(4))
            guard walk.level == 4, parts.count == 4, (try? f.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
                  let d = try? Data(contentsOf: f),
                  let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { continue }
            let layers = (obj["layers"] as? [[String: Any]] ?? []) + [obj["config"] as? [String: Any] ?? [:]]
            let bytes = layers.reduce(Int64(0)) { $0 + ((($1["size"]) as? NSNumber)?.int64Value ?? 0) }
            let base = parts[1] == "library" ? parts[2] : "\(parts[1])/\(parts[2])"
            let name = parts[0] == "registry.ollama.ai" ? base : "\(parts[0])/\(base)"
            out["\(name):\(parts[3])"] = bytes
        }
        return out
    }

    static func existingOllama() -> String? {
        let apps = ["/Applications/Ollama.app", Paths.home.appendingPathComponent("Applications/Ollama.app").path]
        if let a = apps.first(where: { Paths.fm.fileExists(atPath: $0) }) { return a }
        return ollamaCLI()
    }

    /// An `ollama` command installed some other way (Homebrew, the install script).
    static func ollamaCLI() -> String? {
        ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"].first { Paths.fm.isExecutableFile(atPath: $0) }
    }

    static func scan(ramGB: Double = Double(ProcessInfo.processInfo.physicalMemory) / Double(1 << 30)) -> SetupPlan {
        var p = SetupPlan()
        let models = ollamaModelsOnDisk()
        let size = { (tag: String) in models.first { same($0.key, tag) }?.value }
        let cfg = (try? Data(contentsOf: Paths.engineHome.appendingPathComponent("config.json")))
            .flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? [:]
        let tier = tiers.last { ramGB >= $0.minGB } ?? tiers[0]
        let fitting = tiers.filter { ramGB >= $0.minGB }

        if let m = cfg["llm_model"] as? String, !m.isEmpty {
            p.model = m; p.modelReason = "the one your earlier setup chose"
        } else if let t = fitting.last(where: { size($0.tag) != nil }) {
            p.model = t.tag; p.modelReason = "already on this Mac"
        } else {
            p.model = tier.tag; p.modelReason = "picked for this Mac's memory"
        }
        var lo = 0.0, hi = 0.0
        if let b = size(p.model) {
            p.haveModel = true
            p.found.append(Found(what: "the chat model \(p.model)", bytes: b))
        } else if let t = tiers.first(where: { same($0.tag, p.model) }) {
            lo += t.low; hi += t.high
        } else {
            lo += 4; hi += 10  // a model we don't know the size of
        }
        if let b = size(embedTag) { p.found.append(Found(what: "the memory model", bytes: b)) } else { lo += 0.27; hi += 0.27 }

        let voiceDir = Paths.engineHome.appendingPathComponent("models", isDirectory: true)
        let voiceFiles = ["kokoro-v1.0.int8.onnx", "kokoro-v1.0.onnx"].map { voiceDir.appendingPathComponent($0) }
        if let v = voiceFiles.first(where: { Paths.fm.fileExists(atPath: $0.path) }),
           Paths.fm.fileExists(atPath: voiceDir.appendingPathComponent("voices-v1.0.bin").path) {
            let b = ((try? Paths.fm.attributesOfItem(atPath: v.path))?[.size] as? NSNumber)?.int64Value ?? 0
            p.found.append(Found(what: "the parent's voice", bytes: b + 28_000_000))
        } else { lo += 0.12; hi += 0.12 }

        if existingOllama() != nil || Paths.fm.isExecutableFile(atPath: Paths.ollama.path) {
            p.found.append(Found(what: "Ollama", bytes: 0))
        } else { lo += 0.1; hi += 0.1 }

        if !Paths.fm.isExecutableFile(atPath: Paths.holdingLocal.path) { lo += 0.45; hi += 0.45 }
        p.downloadLow = lo; p.downloadHigh = hi
        return p
    }

    /// One plain sentence for the welcome screen.
    var summary: String {
        if nothingFound {
            return "Setting up downloads \(downloadText) once, mostly the chat model (\(model), \(modelReason)). On slow Wi-Fi that can take a while; you can keep using your Mac."
        }
        let names = found.map { $0.bytes > 50_000_000 ? "\($0.what) (\(formatBytes($0.bytes)))" : $0.what }
        let list = names.count > 1 ? names.dropLast().joined(separator: ", ") + " and " + names.last! : names[0]
        let rest = haveModel
            ? "Setup reuses them and only downloads \(downloadText) more."
            : "Setup reuses them. It still downloads \(downloadText), mostly the chat model (\(model), \(modelReason))."
        return "Found on this Mac from an earlier install: \(list). \(rest)"
    }
}
