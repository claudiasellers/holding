// Paths, pinned downloads, child processes and the log file.
import CryptoKit
import Foundation

enum Pins {
    /// Ollama's standalone build (the `ollama` command plus its Metal libraries, no second
    /// menu bar app). Pinned and checked against its published SHA-256, so a new Ollama
    /// release can't change what this app runs without a new build of the app.
    static let ollamaVersion = "v0.40.16"
    static let ollamaSHA256 = "a743717494315da7cd352982b805f6b992d4b4452ca117fd5fbf86c4ee46fca0"
    static var ollamaURL: URL {
        URL(string: "https://github.com/ollama/ollama/releases/download/\(ollamaVersion)/ollama-darwin.tgz")!
    }
    static let port = 8787
    static let ollamaHost = "127.0.0.1:11434"
    static var local: URL { URL(string: "http://127.0.0.1:\(port)")! }
    static var ollama: URL { URL(string: "http://\(ollamaHost)")! }
}

enum Paths {
    static let fm = FileManager.default
    static let env = ProcessInfo.processInfo.environment
    static var home: URL { fm.homeDirectoryForCurrentUser }

    /// Everything this app installs lives here, so "Remove Holding Local" can take it all away.
    /// HOLDING_APP_HOME moves it (the self-test uses a temporary folder).
    static var support: URL {
        if let o = env["HOLDING_APP_HOME"], !o.isEmpty { return URL(fileURLWithPath: o, isDirectory: true) }
        return fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Holding Local", isDirectory: true)
    }
    static var engine: URL { support.appendingPathComponent("engine", isDirectory: true) }
    static var venvBin: URL { engine.appendingPathComponent(".venv/bin", isDirectory: true) }
    static var holdingLocal: URL { venvBin.appendingPathComponent("holding-local") }
    static var ollamaDir: URL { support.appendingPathComponent("ollama", isDirectory: true) }
    static var ollama: URL { ollamaDir.appendingPathComponent("ollama") }
    static var installed: URL { support.appendingPathComponent("installed.json") }
    static var logs: URL {
        if env["HOLDING_APP_HOME"] != nil { return support.appendingPathComponent("logs", isDirectory: true) }
        return home.appendingPathComponent("Library/Logs/Holding Local", isDirectory: true)
    }
    /// The engine's own settings, voices and pairing code (shared with the terminal version).
    static var engineHome: URL {
        if let o = env["HOLDING_LOCAL_HOME"], !o.isEmpty { return URL(fileURLWithPath: o, isDirectory: true) }
        return home.appendingPathComponent(".holding-local", isDirectory: true)
    }
    static var resources: URL { Bundle.main.resourceURL ?? URL(fileURLWithPath: ".") }
    static var bundledUV: URL { resources.appendingPathComponent("bin/uv") }
    static var bundledEngine: URL { resources.appendingPathComponent("engine", isDirectory: true) }
    static var bundledWebApp: URL { resources.appendingPathComponent("app", isDirectory: true) }

    static var tailscale: String? {
        for p in ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
        where fm.isExecutableFile(atPath: p) { return p }
        return nil
    }

    static var appVersion: String {
        let i = Bundle.main.infoDictionary ?? [:]
        return "\(i["CFBundleShortVersionString"] as? String ?? "dev") (\(i["CFBundleVersion"] as? String ?? "0"))"
    }
}

/// Environment for everything this app starts: our venv first, the usual places for
/// Tailscale, and uv kept inside our own folder (its Python, cache and settings).
func childEnvironment() -> [String: String] {
    var e = ProcessInfo.processInfo.environment
    e["PATH"] = [Paths.venvBin.path, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        .joined(separator: ":")
    e["UV_PYTHON_INSTALL_DIR"] = Paths.support.appendingPathComponent("python").path
    e["UV_CACHE_DIR"] = Paths.support.appendingPathComponent("cache/uv").path
    e["UV_PYTHON_PREFERENCE"] = "only-managed"
    e["UV_NO_CONFIG"] = "1"
    e["PYTHONUNBUFFERED"] = "1"
    e["OLLAMA_HOST"] = Pins.ollamaHost
    e.removeValue(forKey: "VIRTUAL_ENV")
    e.removeValue(forKey: "PYTHONHOME")
    e.removeValue(forKey: "PYTHONPATH")
    return e
}

final class LogFile {
    let url: URL
    private let handle: FileHandle?
    private let lock = NSLock()

    init(name: String) {
        try? Paths.fm.createDirectory(at: Paths.logs, withIntermediateDirectories: true)
        url = Paths.logs.appendingPathComponent(name)
        if let size = (try? Paths.fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 5_000_000 {
            try? Paths.fm.removeItem(at: url)
        }
        if !Paths.fm.fileExists(atPath: url.path) { Paths.fm.createFile(atPath: url.path, contents: nil) }
        handle = try? FileHandle(forWritingTo: url)
        _ = try? handle?.seekToEnd()
    }

    func write(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        try? handle?.write(contentsOf: data)
    }

    func line(_ s: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        write(Data("[\(stamp)] \(s)\n".utf8))
        if ProcessInfo.processInfo.environment["HOLDING_LOG_STDOUT"] != nil { print(s) }
    }
}

/// A child process whose output (stdout and stderr together) arrives as lines, in order,
/// and is copied to the log file.
final class ChildProcess {
    let process = Process()
    let lines: AsyncStream<String>
    private var continuation: AsyncStream<String>.Continuation?
    private var buffer = Data()
    private let lock = NSLock()
    private var status: Int32?
    private var waiters: [CheckedContinuation<Int32, Never>] = []
    private let echo = ProcessInfo.processInfo.environment["HOLDING_LOG_STDOUT"] != nil

    init(_ exe: URL, _ args: [String], cwd: URL? = nil, env: [String: String]? = nil, log: LogFile) throws {
        var c: AsyncStream<String>.Continuation?
        lines = AsyncStream(bufferingPolicy: .unbounded) { c = $0 }
        continuation = c
        process.executableURL = exe
        process.arguments = args
        process.environment = env ?? childEnvironment()
        if let cwd { process.currentDirectoryURL = cwd }
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice
        log.line("$ \(exe.lastPathComponent) \(args.joined(separator: " "))")
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            guard let self else { return }
            if d.isEmpty {
                h.readabilityHandler = nil
                self.finish()
                return
            }
            log.write(d)
            if self.echo { FileHandle.standardOutput.write(d) }
            self.consume(d)
        }
        process.terminationHandler = { [weak self] p in
            guard let self else { return }
            self.lock.lock()
            self.status = p.terminationStatus
            let w = self.waiters
            self.waiters = []
            self.lock.unlock()
            w.forEach { $0.resume(returning: p.terminationStatus) }
            // A grandchild can keep the pipe open; don't wait on it forever.
            DispatchQueue.global().asyncAfter(deadline: .now() + 1) { self.finish() }
        }
        try process.run()
    }

    private func consume(_ d: Data) {
        lock.lock()
        buffer.append(d)
        var out: [String] = []
        while let i = buffer.firstIndex(where: { $0 == 10 || $0 == 13 }) {
            let lineData = buffer[buffer.startIndex..<i]
            buffer.removeSubrange(buffer.startIndex...i)
            if let s = String(data: lineData, encoding: .utf8), !s.isEmpty { out.append(s) }
        }
        lock.unlock()
        out.forEach { continuation?.yield($0) }
    }

    private func finish() {
        lock.lock()
        let rest = buffer
        buffer = Data()
        let c = continuation
        continuation = nil
        lock.unlock()
        if let s = String(data: rest, encoding: .utf8), !s.isEmpty { c?.yield(s) }
        c?.finish()
    }

    var running: Bool { process.isRunning }

    func wait() async -> Int32 {
        await withCheckedContinuation { (c: CheckedContinuation<Int32, Never>) in
            lock.lock()
            if let s = status { lock.unlock(); c.resume(returning: s); return }
            waiters.append(c)
            lock.unlock()
        }
    }

    /// SIGTERM, then SIGKILL if it hasn't gone after `grace` seconds.
    func stop(grace: TimeInterval = 4) {
        guard process.isRunning else { return }
        process.terminate()
        let deadline = Date().addingTimeInterval(grace)
        while process.isRunning && Date() < deadline { usleep(50_000) }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }
}

struct AppError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

/// Runs a command to the end, handing each output line to `onLine`.
@MainActor
func runTool(_ exe: URL, _ args: [String], cwd: URL? = nil, log: LogFile, onLine: (String) -> Void = { _ in }) async throws -> Int32 {
    let p = try ChildProcess(exe, args, cwd: cwd, log: log)
    for await line in p.lines { onLine(line) }
    return await p.wait()
}

/// A download with progress, written to a file next to `dest`, then checked and moved there.
final class Downloader: NSObject, URLSessionDownloadDelegate {
    private var continuation: CheckedContinuation<URL, Error>?
    private let progress: @Sendable (Int64, Int64) -> Void
    private let dest: URL

    init(dest: URL, progress: @escaping @Sendable (Int64, Int64) -> Void) {
        self.dest = dest
        self.progress = progress
    }

    static func fetch(_ url: URL, to dest: URL, progress: @escaping @Sendable (Int64, Int64) -> Void) async throws -> URL {
        let d = Downloader(dest: dest, progress: progress)
        let session = URLSession(configuration: .default, delegate: d, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        return try await withCheckedThrowingContinuation { c in
            d.continuation = c
            session.downloadTask(with: url).resume()
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        progress(totalBytesWritten, totalBytesExpectedToWrite)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else {
            continuation?.resume(throwing: AppError("The download answered \(code)."))
            continuation = nil
            return
        }
        do {
            try? Paths.fm.removeItem(at: dest)
            try Paths.fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Paths.fm.moveItem(at: location, to: dest)
            continuation?.resume(returning: dest)
        } catch {
            continuation?.resume(throwing: error)
        }
        continuation = nil
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            continuation?.resume(throwing: error)
            continuation = nil
        }
    }
}

func sha256(of file: URL) throws -> String {
    let h = try FileHandle(forReadingFrom: file)
    defer { try? h.close() }
    var hasher = SHA256()
    while let chunk = try h.read(upToCount: 8 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

func formatBytes(_ n: Int64?) -> String {
    guard let n, n > 0 else { return "0 MB" }
    let f = ByteCountFormatter()
    f.countStyle = .file
    f.allowedUnits = n >= 1_000_000_000 ? [.useGB] : [.useMB]
    return f.string(fromByteCount: n)
}

/// GET or send JSON to a local URL. Throws the server's own message on errors.
func fetchJSON(_ url: URL, method: String = "GET", body: [String: Any]? = nil, timeout: TimeInterval = 10) async throws -> Data {
    var r = URLRequest(url: url, timeoutInterval: timeout)
    r.httpMethod = method
    if let body {
        r.httpBody = try JSONSerialization.data(withJSONObject: body)
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, resp) = try await URLSession.shared.data(for: r)
    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
    if code >= 400 {
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let msg = obj?["detail"] as? String ?? ((obj?["error"] as? [String: Any])?["message"] as? String)
        throw AppError(msg ?? "Holding Local answered \(code).")
    }
    return data
}
