import AppKit
import Foundation

/// On-device study assistant: which Macs get it, the one-time model download,
/// and the separate process that runs the language model.
@MainActor final class AssistantService {
    // Qwen2.5-0.5B-Instruct (Apache-2.0), fetched from the model's own
    // repositories. The pinned digest is checked before the file is ever loaded.
    static let modelName = "qwen2.5-0.5b-instruct-q4_k_m.gguf"
    static let modelSize: Int64 = 491_400_032
    static let modelSHA256 = "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db"
    static let sources = [
        "https://modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/master/qwen2.5-0.5b-instruct-q4_k_m.gguf",
        "https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
        "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    ]
    static let minimumMemory: UInt64 = 16 * 1024 * 1024 * 1024

    /// nil on Apple silicon Macs with at least 16 GB of memory.
    static var unsupportedReason: String? {
        #if arch(arm64)
        return ProcessInfo.processInfo.physicalMemory >= minimumMemory ? nil : "memory"
        #else
        return "processor"
        #endif
    }

    var onChange: (([String: Any]) -> Void)?
    private let store: LocalState
    private let directory = AppIdentity.support.appendingPathComponent("assistant", isDirectory: true)
    // unsupported, waiting, downloading, verifying, paused, error, restart, ready.
    // "ready" is only ever set at launch: a model downloaded in this session
    // becomes active after WLSAPlus is reopened.
    private var phase = "unsupported"
    private var percent: Double = 0
    private var message = ""
    private var download: PackageDownload?
    private var retry: Timer?
    private var idle: Timer?
    private var worker: AssistantWorkerClient?
    private var answering = false

    private var model: URL { directory.appendingPathComponent(Self.modelName) }
    private var marker: URL { directory.appendingPathComponent("model.verified") }

    init(store: LocalState) {
        self.store = store
        guard Self.unsupportedReason == nil else { return }
        let size = (try? FileManager.default.attributesOfItem(atPath: model.path)[.size] as? NSNumber)?.int64Value
        let verified = (try? String(contentsOf: marker, encoding: .utf8)) == Self.modelSHA256
        if size == Self.modelSize && verified { phase = "ready" }
        else { phase = store.value["assistantPaused"] as? Bool == true ? "paused" : "waiting" }
    }

    var status: [String: Any] {
        ["eligible": Self.unsupportedReason == nil, "reason": Self.unsupportedReason ?? "", "phase": phase,
         "percent": percent, "message": message, "sizeMB": Int(Self.modelSize / 1_000_000)]
    }

    private func set(_ phase: String, percent: Double? = nil, message: String = "") {
        self.phase = phase
        if let percent { self.percent = percent }
        self.message = message
        onChange?(status)
    }

    func begin() {
        guard phase == "waiting" else { return }
        Task { try? await Task.sleep(nanoseconds: 10_000_000_000); await fetch() }
    }

    func pause() throws {
        guard ["waiting", "downloading", "error"].contains(phase) else { return }
        try store.set("assistantPaused", true)
        retry?.invalidate()
        set("paused")
        download?.cancel()
    }

    func resume() throws {
        guard ["paused", "error"].contains(phase) else { return }
        try store.set("assistantPaused", false)
        retry?.invalidate()
        set("waiting")
        Task { await fetch() }
    }

    private func fetch() async {
        guard phase == "waiting", download == nil else { return }
        do { try secureDirectory(directory) } catch { set("error", message: error.localizedDescription); return }
        let partial = directory.appendingPathComponent(Self.modelName + ".download")
        set("downloading")
        for source in Self.sources {
            guard let url = URL(string: source) else { continue }
            let transfer = PackageDownload(expected: Self.modelSize, destination: partial) { [weak self] value in
                Task { @MainActor in
                    guard let self, self.phase == "downloading", value - self.percent >= 1 || value >= 100 else { return }
                    self.set("downloading", percent: min(value, 100))
                }
            }
            download = transfer
            do {
                _ = try await transfer.fetch(url)
                download = nil
                guard phase == "downloading" else { return }
                set("verifying", percent: 100)
                let expected = UpdateFile(name: Self.modelName, size: Self.modelSize, sha256: Self.modelSHA256)
                try await Task.detached(priority: .utility) { try NativeUpdater.verifyArchive(partial, file: expected) }.value
                try? FileManager.default.removeItem(at: model)
                try FileManager.default.moveItem(at: partial, to: model)
                try privateWrite(Data(Self.modelSHA256.utf8), to: marker)
                set("restart", percent: 100)
                return
            } catch {
                download = nil
                // A file that fails verification is discarded, never resumed.
                if phase == "verifying" { try? FileManager.default.removeItem(at: partial); phase = "downloading" }
                guard phase == "downloading" else { return }
            }
        }
        set("error", message: "The assistant model could not be downloaded. WLSAPlus will try again later.")
        retry = Timer.scheduledTimer(withTimeInterval: 900, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.phase == "error" else { return }
                self.set("waiting")
                await self.fetch()
            }
        }
    }

    /// Reopens WLSAPlus once this instance has fully quit.
    func relaunch() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "while /bin/kill -0 \"$1\" 2>/dev/null; do /bin/sleep 0.3; done; /usr/bin/open \"$0\"",
                             Bundle.main.bundleURL.path, "\(ProcessInfo.processInfo.processIdentifier)"]
        process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run()
        NSApp.terminate(nil)
    }

    func ask(_ args: [String: Any]) async throws -> [String: Any] {
        guard phase == "ready" else { throw AppError("The assistant is not available yet.") }
        guard let system = args["system"] as? String, let user = args["user"] as? String,
              !user.isEmpty, system.utf8.count <= 4000, user.utf8.count <= 2000 else { throw AppError("Invalid assistant request.") }
        guard !answering else { throw AppError("The assistant is still answering the previous question.") }
        answering = true
        idle?.invalidate()
        defer {
            answering = false
            // The loaded model holds about 2.5 GB; release it after a quiet spell.
            idle = Timer.scheduledTimer(withTimeInterval: 300, repeats: false) { [weak self] _ in
                Task { @MainActor in self?.stopWorker() }
            }
        }
        let limit = min(max(args["maxTokens"] as? Int ?? 120, 1), 200)
        if worker?.isRunning != true {
            let client = try AssistantWorkerClient(model: model)
            worker = client
            let hello = try await client.expect()
            guard hello["ready"] as? Bool == true else {
                stopWorker()
                // Forget a model that will not load so it is fetched again next launch.
                try? FileManager.default.removeItem(at: marker)
                throw AppError(hello["error"] as? String ?? "The assistant model could not be loaded.")
            }
        }
        guard let client = worker else { throw AppError("The assistant is not running.") }
        let watchdog = DispatchWorkItem { client.stop() }
        DispatchQueue.global().asyncAfter(deadline: .now() + 180, execute: watchdog)
        defer { watchdog.cancel() }
        let reply = try await client.request(["system": system, "user": user, "maxTokens": limit])
        if let failure = reply["error"] as? String { throw AppError(failure) }
        return ["text": reply["text"] as? String ?? ""]
    }

    func stopWorker() {
        worker?.stop()
        worker = nil
    }
}

/// Talks to the model process over its standard input and output, one JSON
/// object per line, answered in order.
final class AssistantWorkerClient {
    private let process = Process()
    private let input = Pipe(), output = Pipe()
    private let queue = DispatchQueue(label: "wlsaplus.assistant.worker")
    private var buffer = Data()
    private var waiting: [(Result<[String: Any], Error>) -> Void] = []
    private var stopped = false

    var isRunning: Bool { process.isRunning }

    init(model: URL) throws {
        guard let executable = Bundle.main.executableURL else { throw AppError("Cannot locate the assistant executable.") }
        process.executableURL = executable
        process.arguments = ["--llm-worker", model.path]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            self?.queue.async { self?.receive(data) }
        }
        process.terminationHandler = { [weak self] _ in
            self?.queue.async { self?.failAll() }
        }
        try process.run()
    }

    private func receive(_ data: Data) {
        if data.isEmpty { output.fileHandleForReading.readabilityHandler = nil; failAll(); return }
        buffer.append(data)
        guard buffer.count <= 1_048_576 else { stop(); return }
        while let newline = buffer.firstIndex(of: 10) {
            let line = Data(buffer[buffer.startIndex..<newline])
            buffer.removeSubrange(buffer.startIndex...newline)
            guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any], !waiting.isEmpty else { continue }
            waiting.removeFirst()(.success(object))
        }
    }

    private func failAll() {
        stopped = true
        let pending = waiting
        waiting.removeAll()
        for waiter in pending { waiter(.failure(AppError("The assistant stopped before it finished answering."))) }
    }

    /// Waits for the next line without sending anything (the start-up message).
    func expect() async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                guard !self.stopped else { continuation.resume(throwing: AppError("The assistant is not running.")); return }
                self.waiting.append { continuation.resume(with: $0) }
            }
        }
    }

    func request(_ object: [String: Any]) async throws -> [String: Any] {
        var line = try JSONSerialization.data(withJSONObject: object)
        line.append(10)
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                guard !self.stopped else { continuation.resume(throwing: AppError("The assistant is not running.")); return }
                self.waiting.append { continuation.resume(with: $0) }
                do { try self.input.fileHandleForWriting.write(contentsOf: line) } catch { self.failAll() }
            }
        }
    }

    func stop() {
        if process.isRunning { process.terminate() }
        queue.async { self.failAll() }
    }
}

/// The model process: `WLSAPlus --llm-worker MODEL`. Loads the model once,
/// then answers one request per input line until its input closes.
enum AssistantWorker {
    private final class Collector { var data = Data() }

    private static func send(_ object: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
        data.append(10)
        FileHandle.standardOutput.write(data)
    }

    static func run(modelPath: String) {
        let capacity = 256
        var problem = [CChar](repeating: 0, count: capacity)
        guard let model = wlm_load(modelPath, &problem, capacity) else { send(["error": String(cString: problem)]); return }
        defer { wlm_free(model) }
        guard let session = wlm_session_new(model, 2048) else { send(["error": "There is not enough memory for the assistant."]); return }
        defer { wlm_session_free(session) }
        send(["ready": true])
        let emit: wlm_emit = { context, bytes, length in
            guard let context, let bytes, length > 0 else { return 0 }
            let collector = Unmanaged<Collector>.fromOpaque(context).takeUnretainedValue()
            bytes.withMemoryRebound(to: UInt8.self, capacity: Int(length)) { collector.data.append($0, count: Int(length)) }
            return collector.data.count > 16384 ? 1 : 0
        }
        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8), let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let system = request["system"] as? String, let user = request["user"] as? String else { send(["error": "Invalid assistant request."]); continue }
            let limit = Int32(min(max(request["maxTokens"] as? Int ?? 120, 1), 200))
            let collector = Collector()
            let produced = wlm_chat(session, system, user, limit, emit, Unmanaged.passUnretained(collector).toOpaque())
            if produced < 0 { send(["error": "The question is too long for the assistant."]); continue }
            send(["text": String(decoding: collector.data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)])
        }
    }
}
