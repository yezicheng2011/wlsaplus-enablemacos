import Foundation
import CryptoKit
import AppKit
import Darwin

private final class PackageDownload: NSObject, URLSessionDownloadDelegate {
    let expected: Int64
    let destination: URL
    let progress: (Double) -> Void
    private var continuation: CheckedContinuation<URL, Error>?
    private var result: Result<URL, Error>?
    private var session: URLSession?
    private var resumeFile: URL?
    init(expected: Int64, destination: URL, progress: @escaping (Double) -> Void) { self.expected = expected; self.destination = destination; self.progress = progress }
    func fetch(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 300; configuration.timeoutIntervalForResource = 3600
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
            self.session = session
            let identifier = SHA256.hash(data: Data(url.absoluteString.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
            let resume = destination.appendingPathExtension("resume-" + identifier)
            self.resumeFile = resume
            if let saved = try? Data(contentsOf: resume) { session.downloadTask(withResumeData: saved).resume() }
            else { var request = URLRequest(url: url); request.cachePolicy = .reloadIgnoringLocalCacheData; session.downloadTask(with: request).resume() }
        }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > expected || (totalBytesExpectedToWrite > 0 && totalBytesExpectedToWrite != expected) {
            result = .failure(AppError("Update download size does not match the signed manifest.")); downloadTask.cancel(); return
        }
        progress(Double(totalBytesWritten) * 100 / Double(expected))
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let response = downloadTask.response as? HTTPURLResponse, response.statusCode == 200 || response.statusCode == 206 else { result = .failure(AppError("Update download failed.")); return }
        do {
            if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
            try FileManager.default.moveItem(at: location, to: destination)
            if let resumeFile { try? FileManager.default.removeItem(at: resumeFile) }
            result = .success(destination)
        } catch { result = .failure(error) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error as NSError?, let resume = error.userInfo[NSURLSessionDownloadTaskResumeData] as? Data, let resumeFile {
            try? privateWrite(resume, to: resumeFile)
        }
        let completed = result ?? .failure(error ?? AppError("Update download did not finish."))
        continuation?.resume(with: completed); continuation = nil
        session.finishTasksAndInvalidate(); self.session = nil
    }
}

@MainActor final class NativeUpdater {
    var onChange: (([String: Any]) -> Void)?
    var disconnect: (() async throws -> Void)?
    var status: [String: Any] = ["state": "idle", "message": "Ready to check for updates.", "percent": NSNull()]
    let directory = AppIdentity.support.appendingPathComponent("updates", isDirectory: true)
    let store: LocalState
    private var operation: Task<Void, Never>?
    private var staged: URL?
    private var manifest: UpdateManifest?
    private var timer: Timer?
    private var channelGeneration = 0
    init(store: LocalState) {
        self.store = store
        let outcome = directory.appendingPathComponent("install-result.json")
        if let data = try? Data(contentsOf: outcome), let value = try? jsonObject(data, maximum: 16384),
           let message = value["message"] as? String {
            status = ["state": "error", "message": message, "percent": NSNull()]
            try? FileManager.default.removeItem(at: outcome)
        }
    }
    var beta: Bool { store.value["channel"] as? String == "beta" }
    var architecture: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x64"
        #endif
    }
    func begin() {
        timer = Timer.scheduledTimer(withTimeInterval: 21600, repeats: true) { [weak self] _ in Task { @MainActor [weak self] in self?.check() } }
        Task { try? await Task.sleep(nanoseconds: 8_000_000_000); check() }
    }
    func set(_ state: String, _ message: String, percent: Double? = nil) {
        status = ["state": state, "status": state, "message": message, "currentVersion": AppIdentity.version, "channel": beta ? "beta" : "stable", "percent": percent as Any? ?? NSNull(), "version": manifest?.version as Any? ?? NSNull()]
        log("\(state): \(message)")
        onChange?(status)
    }
    func log(_ message: String) {
        do {
            try secureDirectory(directory)
            let file = directory.appendingPathComponent("update.log")
            if let size = try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber, size.intValue > 512*1024 { try? FileManager.default.removeItem(at: file) }
            if !FileManager.default.fileExists(atPath: file.path) { try privateWrite(Data(), to: file) }
            let handle = try FileHandle(forWritingTo: file); defer { try? handle.close() }
            try handle.seekToEnd(); try handle.write(contentsOf: Data("\(ISO8601DateFormatter().string(from: Date())) \(message)\n".utf8))
        } catch { /* Logs never bypass a verification error. */ }
    }
    func check() {
        guard operation == nil, staged == nil else { return }
        operation = Task { await performCheck(); operation = nil }
    }
    func channelChanged() {
        channelGeneration += 1
        staged = nil; manifest = nil
        set("idle", "Update channel changed. Check for updates again.")
    }
    private func failedVersions() -> [String] {
        let file = directory.appendingPathComponent("failed-versions.json")
        var failed = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String]) ?? []
        if let legacy = try? jsonObject(Data(contentsOf: directory.appendingPathComponent("settings.json")), maximum: 65536), let old = legacy["failedVersions"] as? [String] { failed += old }
        return Array(Set(failed))
    }
    private func assetURLs(tag: String, name: String) -> [URL] {
        let host = "https://wlsaplus.spacehubxyz.hk"
        let path = "yezicheng2011/wlsaplus-enablemacos/releases/download/\(tag)/\(name)"
        return ["\(host)/download/\(tag)/\(name)?via=direct", "https://gh-proxy.com/https://github.com/\(path)", "https://edgeone.gh-proxy.org/https://github.com/\(path)"].compactMap(URL.init(string:))
    }
    private func small(_ urls: [URL]) async throws -> Data {
        var last: Error = AppError("No update server answered.")
        for url in urls {
            do {
                var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 90)
                request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
                let (data, response) = try await boundedResponse(request, maximum: 65536)
                guard response.statusCode == 200 else { throw AppError("Update server returned an invalid manifest response.") }
                return data
            } catch { last = error; log("manifest request failed: \(url.host ?? "")") }
        }
        throw last
    }
    private func performCheck() async {
        let epoch = channelGeneration, wantedBeta = beta
        set("checking", "Checking for updates…")
        do {
            var candidates: [UpdateManifest] = []
            var failure: Error?
            do {
                let latest = try jsonObject(await small([URL(string: "https://wlsaplus.spacehubxyz.hk/api/latest")!]), maximum: 65536)
                guard let tag = latest["tag_name"] as? String ?? latest["tag"] as? String, matches(tag, #"^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$"#) else { throw AppError("Update server returned an invalid release tag.") }
                candidates.append(try UpdateManifest.verified(await small(assetURLs(tag: tag, name: "update-manifest.json"))))
            } catch {
                failure = error
                let urls = ["https://gh-proxy.com/", "https://edgeone.gh-proxy.org/"].compactMap { URL(string: $0 + "https://github.com/yezicheng2011/wlsaplus-enablemacos/releases/latest/download/update-manifest.json") }
                do { candidates.append(try UpdateManifest.verified(await small(urls))) }
                catch { failure = error }
            }
            if wantedBeta {
                do { candidates.append(try UpdateManifest.verified(await small(assetURLs(tag: "channel-beta", name: "update-manifest.json")))) }
                catch { failure = error }
            }
            guard !candidates.isEmpty else { throw failure ?? AppError("No signed update manifest found.") }
            let os = ProcessInfo.processInfo.operatingSystemVersion
            let failed = failedVersions()
            guard epoch == channelGeneration else { throw CancellationError() }
            let eligible = try candidates.filter { try $0.eligible(current: AppIdentity.version, beta: wantedBeta, failed: failed, os: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)") }
            let ordered = try eligible.sorted { try SemanticVersion($0.version) > SemanticVersion($1.version) }
            guard let selected = ordered.first else {
                set("up-to-date", "WLSAPlus is up to date."); return
            }
            guard let file = selected.file(architecture: architecture) else { throw AppError("This update has no package for this Mac.") }
            manifest = selected
            let staging = directory.appendingPathComponent("staging/\(selected.version)", isDirectory: true)
            try secureDirectory(staging)
            let archive = staging.appendingPathComponent(file.name)
            set("downloading", "Downloading WLSAPlus \(selected.version)…", percent: 0)
            var downloaded = false
            for url in assetURLs(tag: selected.tag, name: file.name) {
                do {
                    let job = PackageDownload(expected: file.size, destination: archive) { [weak self] progress in
                        Task { @MainActor in
                            guard let self, self.channelGeneration == epoch else { return }
                            self.set("downloading", "Downloading WLSAPlus \(selected.version)…", percent: progress)
                        }
                    }
                    _ = try await job.fetch(url)
                    try Self.verifyArchive(archive, file: file)
                    downloaded = true; break
                } catch { log("package attempt failed: \(error.localizedDescription)"); try? FileManager.default.removeItem(at: archive) }
            }
            guard downloaded else { throw AppError("Could not download and verify the update. Check the update log.") }
            guard epoch == channelGeneration else { throw CancellationError() }
            try ArchivePolicy.validate(archive)
            let unpacked = staging.appendingPathComponent("unpacked", isDirectory: true)
            try? FileManager.default.removeItem(at: unpacked)
            try secureDirectory(unpacked)
            try run("/usr/bin/ditto", ["-x", "-k", archive.path, unpacked.path])
            let candidate = unpacked.appendingPathComponent("WLSAPlus.app", isDirectory: true)
            try Self.verifyApp(candidate, version: selected.version, architecture: architecture)
            staged = candidate
            set("ready", "Update ready — restart to install WLSAPlus \(selected.version).", percent: 100)
        } catch {
            if error is CancellationError || epoch != channelGeneration { set("idle", "Update channel changed. Check for updates again.") }
            else { set("error", error.localizedDescription) }
        }
    }
    nonisolated static func verifyArchive(_ url: URL, file: UpdateFile) throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard (attributes[.size] as? NSNumber)?.int64Value == file.size else { throw AppError("Update package size mismatch.") }
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var hash = SHA256()
        while let chunk = try handle.read(upToCount: 1024*1024), !chunk.isEmpty { hash.update(data: chunk) }
        let actual = hash.finalize().map { String(format: "%02x", $0) }.joined()
        guard actual == file.sha256 else { throw AppError("Update package SHA-256 mismatch.") }
    }
    nonisolated static func verifyApp(_ url: URL, version: String, architecture: String) throws {
        try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", url.path])
        try run("/usr/bin/codesign", ["--verify", "-R=" + AppIdentity.requirement, url.path])
        let plist = try Data(contentsOf: url.appendingPathComponent("Contents/Info.plist"))
        guard let info = try PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any], info["CFBundleIdentifier"] as? String == AppIdentity.bundle,
              info["CFBundleShortVersionString"] as? String == version, info["CFBundleExecutable"] as? String == "WLSAPlus" else { throw AppError("The update bundle identity or version is incorrect.") }
        let executable = url.appendingPathComponent("Contents/MacOS/WLSAPlus")
        let arches = try run("/usr/bin/lipo", ["-archs", executable.path]).split(whereSeparator: \.isWhitespace)
        guard arches.contains(Substring(architecture == "x64" ? "x86_64" : "arm64")) else { throw AppError("The update does not support this Mac's processor.") }
    }
    func install(restart: Bool = true) async throws {
        guard let staged, let manifest else { throw AppError("No verified update is ready.") }
        let epoch = channelGeneration
        let os = ProcessInfo.processInfo.operatingSystemVersion
        guard try manifest.eligible(current: AppIdentity.version, beta: beta, failed: failedVersions(), os: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)") else {
            self.staged = nil; self.manifest = nil; set("idle", "The selected update no longer matches this channel.")
            throw AppError("Check for updates again on the selected channel.")
        }
        try await disconnect?()
        guard epoch == channelGeneration else { throw AppError("The update channel changed. Check again before installing.") }
        try Self.verifyApp(staged, version: manifest.version, architecture: architecture)
        let target = Bundle.main.bundleURL
        guard target.pathExtension == "app", !target.path.hasPrefix("/Volumes/"), !target.path.contains("/AppTranslocation/") else { throw AppError("Move WLSAPlus to Applications before updating.") }
        let helper = directory.appendingPathComponent("native-install-helper")
        try? FileManager.default.removeItem(at: helper)
        guard let executable = Bundle.main.executableURL else { throw AppError("Cannot locate the installer executable.") }
        try FileManager.default.copyItem(at: executable, to: helper)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
        let marker = directory.appendingPathComponent("staging/\(manifest.version)/launched.marker")
        try? FileManager.default.removeItem(at: marker)
        let child = Process()
        child.executableURL = helper
        child.arguments = ["--native-installer", "\(getpid())", target.path, staged.path, marker.path, manifest.version, restart ? "restart" : "quit"]
        child.standardInput = FileHandle.nullDevice; child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
        try child.run()
        set("installing", "Installing the verified update…")
        NSApplication.shared.terminate(nil)
    }
}

enum UpdateInstaller {
    static func acknowledge(arguments: [String]) throws {
        guard let argument = arguments.first(where: { $0.hasPrefix("--wlsaplus-update-marker=") }) else { return }
        let candidate = String(argument.dropFirst("--wlsaplus-update-marker=".count))
        let url = URL(fileURLWithPath: candidate).standardizedFileURL
        let root = AppIdentity.support.appendingPathComponent("updates/staging", isDirectory: true).standardizedFileURL
        guard url.lastPathComponent == "launched.marker", url.path.hasPrefix(root.path + "/"), url.deletingLastPathComponent().deletingLastPathComponent() == root,
              matches(url.deletingLastPathComponent().lastPathComponent, #"^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$"#) else { throw AppError("Invalid update startup marker.") }
        try privateWrite(Data("ready\n".utf8), to: url)
    }
    static func perform(_ arguments: [String]) throws {
        guard arguments.count == 7, let parent = Int32(arguments[1]), parent > 1 else { throw AppError("Invalid installer arguments.") }
        let target = URL(fileURLWithPath: arguments[2]).standardizedFileURL, staged = URL(fileURLWithPath: arguments[3]).standardizedFileURL,
            marker = URL(fileURLWithPath: arguments[4]).standardizedFileURL, version = arguments[5], restart = arguments[6] == "restart"
        let root = AppIdentity.support.appendingPathComponent("updates/staging", isDirectory: true).standardizedFileURL
        guard target.pathExtension == "app", !target.path.hasPrefix("/Volumes/"), !target.path.contains("/AppTranslocation/"),
              staged.path.hasPrefix(root.path + "/"), marker.path.hasPrefix(root.path + "/"), marker.lastPathComponent == "launched.marker" else { throw AppError("Installer path validation failed.") }
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x64"
        #endif
        for _ in 0..<120 { if kill(parent, 0) != 0 && errno == ESRCH { break }; usleep(500_000) }
        guard kill(parent, 0) != 0 else { throw AppError("The application did not exit; update cancelled.") }
        let backup = target.deletingLastPathComponent().appendingPathComponent(".WLSAPlus-backup-\(UUID().uuidString).app")
        let prepared = target.deletingLastPathComponent().appendingPathComponent(".WLSAPlus-update-\(UUID().uuidString).app")
        func command(_ tool: String, _ args: [String]) throws {
            if FileManager.default.isWritableFile(atPath: target.deletingLastPathComponent().path) { try run(tool, args) }
            else { try elevatedCommand(tool, args) }
        }
        var installed = false
        do {
            try? FileManager.default.removeItem(at: AppIdentity.support.appendingPathComponent("updates/install-result.json"))
            try NativeUpdater.verifyApp(staged, version: version, architecture: arch)
            let currentPlist = try Data(contentsOf: target.appendingPathComponent("Contents/Info.plist"))
            guard let currentInfo = try PropertyListSerialization.propertyList(from: currentPlist, format: nil) as? [String: Any],
                  let currentVersion = currentInfo["CFBundleShortVersionString"] as? String else { throw AppError("The installed application identity is missing.") }
            // A renamed .app is supported, but it must still be the trusted app.
            try NativeUpdater.verifyApp(target, version: currentVersion, architecture: arch)
            try command("/usr/bin/ditto", [staged.path, prepared.path])
            try NativeUpdater.verifyApp(prepared, version: version, architecture: arch)
            try command("/bin/mv", [target.path, backup.path])
            do { try command("/bin/mv", [prepared.path, target.path]) }
            catch { try? command("/bin/mv", [backup.path, target.path]); throw error }
            installed = true
            var args = [target.path, "--args", "--wlsaplus-update-marker=" + marker.path]
            if !restart { args.insert(contentsOf: ["-g", "-j"], at: 0); args.append("--wlsaplus-update-verify-only") }
            try run("/usr/bin/open", args)
            var started = false
            for _ in 0..<180 { if FileManager.default.fileExists(atPath: marker.path) { started = true; break }; usleep(500_000) }
            guard started else { throw AppError("The new application did not confirm startup.") }
            try? command("/bin/rm", ["-rf", backup.path])
        } catch {
            let original = error
            try? privateWrite(jsonData(["message": "The update could not be installed: " + original.localizedDescription]),
                              to: AppIdentity.support.appendingPathComponent("updates/install-result.json"))
            // Running applications are identified by their exact bundle path.
            if installed {
                for app in NSWorkspace.shared.runningApplications where app.bundleURL?.standardizedFileURL == target { app.forceTerminate() }
            }
            if FileManager.default.fileExists(atPath: backup.path) {
                try? command("/bin/rm", ["-rf", target.path]); try command("/bin/mv", [backup.path, target.path])
            }
            if installed {
                let file = AppIdentity.support.appendingPathComponent("updates/failed-versions.json")
                var failures = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String]) ?? []
                if !failures.contains(version) { failures.append(version) }
                try? privateWrite(JSONSerialization.data(withJSONObject: failures), to: file)
            }
            // Failure before replacement (including cancelled authorization)
            // reopens the old app without treating the candidate as defective.
            try? run("/usr/bin/open", [target.path])
            throw original
        }
    }
}
