import Foundation
import AppKit
import WebKit
import UserNotifications
import ServiceManagement

// These clients implement public HTTP contracts. No third-party client code or assets are used.
private final class UserServiceHTTPPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Translation queries and especially SSO payloads must never follow a remote redirect.
        completionHandler(nil)
    }
}

private enum ForumPolicy {
    static let origin = URL(string: "https://lt.spacehubxyz.hk")!
    static let hosts: Set<String> = ["lt.spacehubxyz.hk", "lt.spacehubxyz.xn--j6w193g"]
    static func approved(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && hosts.contains(url.host?.lowercased() ?? "") && (url.port == nil || url.port == 443) && url.user == nil && url.password == nil
    }
    static func sameOrigin(_ url: URL) -> Bool {
        approved(url) && url.host?.lowercased() == origin.host?.lowercased()
    }
    static func entry(theme: String) -> URL {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        components.path = "/"
        components.queryItems = [URLQueryItem(name: "embed", value: "wlsaplus"), URLQueryItem(name: "theme", value: theme)]
        return components.url!
    }
    static func consumptionURL(_ value: String) throws -> URL {
        guard let url = URL(string: value), sameOrigin(url), url.path == "/sso/consume", url.fragment == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw AppError("The forum returned an invalid sign-in address.") }
        let tokens = components.queryItems?.filter { $0.name == "token" } ?? []
        let destinations = components.queryItems?.filter { $0.name == "next" } ?? []
        guard tokens.count == 1, let token = tokens[0].value, !token.isEmpty, token.utf8.count <= 8192,
              destinations.count == 1, let next = destinations[0].value,
              next.hasPrefix("/"), !next.hasPrefix("//"), !next.contains("\\"), !next.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let destination = URL(string: next, relativeTo: origin)?.absoluteURL, sameOrigin(destination) else {
            throw AppError("The forum returned an invalid sign-in address.")
        }
        // A second decoding cannot turn an encoded relative path into a network-path redirect.
        let decoded = next.removingPercentEncoding ?? next
        guard !decoded.hasPrefix("//"), !decoded.contains("\\") else { throw AppError("The forum returned an invalid sign-in address.") }
        return url
    }
}

@MainActor private final class ForumNavigation: NSObject, WKNavigationDelegate, WKUIDelegate {
    var failure: ((String) -> Void)?
    var loaded: (() -> Void)?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?() }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if ForumPolicy.approved(url) {
            if action.targetFrame == nil { webView.load(action.request); decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
        } else {
            // Never export SSO token addresses to another application.
            if (action.targetFrame == nil || action.targetFrame?.isMainFrame == true), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil, url.query?.contains("token=") != true {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let url = response.response.url, ForumPolicy.approved(url) else { decisionHandler(.cancel); return }
        decisionHandler(response.canShowMIMEType ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if ForumPolicy.approved(url) { webView.load(action.request) }
        else if ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.query?.contains("token=") != true, url.user == nil, url.password == nil { NSWorkspace.shared.open(url) }
        return nil
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { report(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { report(error) }
    private func report(_ error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { failure?("The forum could not load. Check your connection and try Reload.") }
    }
}

@MainActor final class UserServices: NSObject {
    let store: LocalState
    let school: SchoolService
    var onChange: (([String: Any]) -> Void)?
    private(set) var notice: [String: Any]?
    private let http: URLSession
    private var forumWindow: NSWindow?
    private var forumView: WKWebView?
    private var forumNavigation: ForumNavigation?
    private var forumStatus: NSTextField?
    private var forumStore = WKWebsiteDataStore.nonPersistent()
    private var forumGeneration = 0
    private var forumOpening = false
    private var mapWindow: NSWindow?
    private var mapView: WKWebView?
    private var mapSelection: Int?
    private var mapQuery = ""
    private var appearanceObservation: NSKeyValueObservation?
    private var reminderGeneration = 0
    private var desiredReminderIDs = Set<String>()
    private static let accentHex: [String: String] = ["default": "#00677a", "red": "#b9363e", "orange": "#bd5b12", "yellow": "#8c710c", "green": "#287a50", "blue": "#315fbc", "purple": "#7754ae", "pink": "#b43d82", "rose": "#ad4b63"]

    init(store: LocalState, school: SchoolService) {
        self.store = store
        self.school = school
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 18
        configuration.timeoutIntervalForResource = 45
        http = URLSession(configuration: configuration, delegate: UserServiceHTTPPolicy(), delegateQueue: nil)
        notice = store.value["notice"] as? [String: Any]
        super.init()
        applyWindowAppearance()
        appearanceObservation = NSApp.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, _ in
            Task { @MainActor [weak self] in
                guard let self, self.store.value["appearance"] as? String == "system" else { return }
                await self.updateForumTheme()
                self.refreshMap()
            }
        }
    }

    // The input is never saved; request URLs and provider errors are never logged or returned.
    func translate(_ args: [String: Any]) async throws -> [String: Any] {
        guard let text = args["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 10_000, text.utf8.count <= 40_000,
              let source = args["from"] as? String, let target = args["to"] as? String else { throw AppError("Enter text and choose a target language.") }
        let languages: Set<String> = ["auto", "en", "zh-Hans", "zh-Hant", "zh-CN", "zh-TW", "es", "fr", "de", "ja", "ko", "ru", "ar", "pt", "it"]
        guard languages.contains(source), languages.contains(target), target != "auto", source != target else { throw AppError("Choose different, supported source and target languages.") }
        do { return try await googleTranslation(text, source: source, target: target) }
        catch is CancellationError { throw CancellationError() }
        catch {
            do { return try await memoryTranslation(text, source: source, target: target) }
            catch is CancellationError { throw CancellationError() }
            catch { throw AppError("Translation providers are unavailable or their free quota has been reached. Try again later.") }
        }
    }
    private func language(_ value: String) -> String {
        ["zh-Hans": "zh-CN", "zh-Hant": "zh-TW"][value] ?? value
    }
    private func googleTranslation(_ text: String, source: String, target: String) async throws -> [String: Any] {
        var components = URLComponents(string: "https://translate.googleapis.com/translate_a/single")!
        components.queryItems = [URLQueryItem(name: "client", value: "gtx"), URLQueryItem(name: "dt", value: "t"), URLQueryItem(name: "sl", value: language(source)), URLQueryItem(name: "tl", value: language(target)), URLQueryItem(name: "q", value: text)]
        let data = try await bounded(URLRequest(url: components.url!), maximum: 2 * 1024 * 1024)
        guard let body = try JSONSerialization.jsonObject(with: data) as? [Any], let segments = body.first as? [[Any]] else { throw AppError("No translation was returned.") }
        let result = segments.compactMap { $0.first as? String }.joined()
        guard !result.isEmpty else { throw AppError("No translation was returned.") }
        return ["text": result, "detectedLanguage": body.count > 2 ? body[2] as? String ?? "" : "", "provider": "Google Translate"]
    }
    private func memoryTranslation(_ text: String, source: String, target: String) async throws -> [String: Any] {
        var output = "", detected = ""
        for chunk in try Self.utf8Chunks(text, maximum: 450) {
            try Task.checkCancellation()
            let leading = String(chunk.prefix(while: { $0.isWhitespace }))
            let trailing = String(chunk.reversed().prefix(while: { $0.isWhitespace }).reversed())
            let content = chunk.trimmingCharacters(in: .whitespacesAndNewlines)
            if content.isEmpty { output += chunk; continue }
            var components = URLComponents(string: "https://api.mymemory.translated.net/get")!
            components.queryItems = [URLQueryItem(name: "q", value: content), URLQueryItem(name: "langpair", value: "\(source == "auto" ? "autodetect" : language(source))|\(language(target))")]
            let body = try jsonObject(await bounded(URLRequest(url: components.url!), maximum: 256 * 1024), maximum: 256 * 1024)
            guard (body["responseStatus"] as? NSNumber)?.intValue == 200, body["quotaFinished"] as? Bool != true,
                  let response = body["responseData"] as? [String: Any], let translated = response["translatedText"] as? String, !translated.isEmpty else { throw AppError("The fallback translation provider is unavailable.") }
            output += leading + Self.decodeEntities(translated) + trailing
            if detected.isEmpty { detected = response["detectedLanguage"] as? String ?? "" }
        }
        guard !output.isEmpty else { throw AppError("No translation was returned.") }
        return ["text": output, "detectedLanguage": detected, "provider": "MyMemory"]
    }
    static func utf8Chunks(_ text: String, maximum: Int) throws -> [String] {
        guard maximum > 0 else { throw AppError("Invalid translation chunk size.") }
        var chunks: [String] = [], current = "", size = 0
        // Split only at Character boundaries; a multi-byte character is never truncated.
        for character in text {
            let addition = String(character), count = addition.utf8.count
            guard count <= maximum else { throw AppError("A text character is too large to translate.") }
            if size + count > maximum {
                if let boundary = current.lastIndex(where: { $0.isWhitespace }), current[..<boundary].utf8.count >= maximum / 2 {
                    let after = current.index(after: boundary)
                    chunks.append(String(current[..<after]))
                    current = String(current[after...]); size = current.utf8.count
                } else { chunks.append(current); current = ""; size = 0 }
                if size + count > maximum { chunks.append(current); current = ""; size = 0 }
            }
            current += addition; size += count
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }
    private static func decodeEntities(_ text: String) -> String {
        let entities = ["amp": "&", "quot": "\"", "apos": "'", "lt": "<", "gt": ">", "nbsp": " "]
        guard let regex = try? NSRegularExpression(pattern: #"&(#x[0-9A-Fa-f]{1,8}|#[0-9]{1,8}|[A-Za-z]{2,8});"#) else { return text }
        var result = text
        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            guard let full = Range(match.range, in: result), let nameRange = Range(match.range(at: 1), in: text) else { continue }
            let name = String(text[nameRange])
            var replacement = entities[name]
            if name.hasPrefix("#x"), let scalar = UInt32(name.dropFirst(2), radix: 16).flatMap(UnicodeScalar.init) { replacement = String(scalar) }
            else if name.hasPrefix("#"), let scalar = UInt32(name.dropFirst()).flatMap(UnicodeScalar.init) { replacement = String(scalar) }
            if let replacement { result.replaceSubrange(full, with: replacement) }
        }
        return result
    }
    private func bounded(_ request: URLRequest, maximum: Int) async throws -> Data {
        guard let url = request.url, url.scheme == "https", url.user == nil, url.password == nil else { throw AppError("A secure service address is required.") }
        let allowed: Set<String> = ["translate.googleapis.com", "api.mymemory.translated.net", "wlsaplus.spacehubxyz.hk", "lt.spacehubxyz.hk"]
        guard allowed.contains(url.host?.lowercased() ?? ""), url.port == nil || url.port == 443 else { throw AppError("The service address is not allowed.") }
        let (bytes, response) = try await http.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), response.url?.host == url.host,
              response.expectedContentLength <= Int64(maximum) else { throw AppError("The remote service failed or returned an oversized response.") }
        var data = Data()
        for try await byte in bytes {
            if data.count >= maximum { throw AppError("The remote response exceeded the size limit.") }
            data.append(byte)
        }
        return data
    }

    func scheduleReminders() async throws {
        reminderGeneration += 1
        let epoch = reminderGeneration, center = UNUserNotificationCenter.current()
        let oldIDs = store.value["reminderIDs"] as? [String] ?? []
        guard store.value["reminders"] as? Bool != false else {
            desiredReminderIDs = []
            try await clearClassReminders(center, epoch: epoch, previousIDs: oldIDs)
            return
        }
        let snapshot = store.value["snapshot"] as? [String: Any] ?? [:]
        let entries = snapshot["schedule"] as? [[String: Any]] ?? []
        let now = Date() // Time tuning is deliberately excluded from notification scheduling.
        let upcoming = entries.compactMap { item -> (item: [String: Any], start: Date, fire: Date)? in
            guard let value = item["start"] as? String, let start = Self.isoDate(value) else { return nil }
            let fire = start.addingTimeInterval(-300)
            return fire > now.addingTimeInterval(1) ? (item, start, fire) : nil
        }.sorted { $0.fire < $1.fire }.prefix(64)
        desiredReminderIDs = Set(upcoming.map { entry in
            let course = entry.item["title"] as? String ?? entry.item["name"] as? String ?? "Class"
            return "wlsaplus.class." + Self.stableHash("\(entry.item["id"] ?? course)|\(entry.start.timeIntervalSince1970)|\(course)")
        })
        if upcoming.isEmpty {
            try await clearClassReminders(center, epoch: epoch, previousIDs: oldIDs)
            return
        }
        let authorization = await center.notificationSettings()
        if authorization.authorizationStatus == .notDetermined {
            guard try await center.requestAuthorization(options: [.alert, .sound]) else { throw AppError("Class reminders are disabled in macOS Notifications settings.") }
        } else if authorization.authorizationStatus == .denied { throw AppError("Allow WLSAPlus in macOS Notifications settings to receive class reminders.") }
        guard epoch == reminderGeneration else { return }
        let pending = await center.pendingNotificationRequests()
        var desired: [String] = []
        var scheduled = Set<String>()
        for entry in upcoming {
            guard epoch == reminderGeneration else { return }
            let course = entry.item["title"] as? String ?? entry.item["name"] as? String ?? "Class"
            let identity = "\(entry.item["id"] ?? course)|\(entry.start.timeIntervalSince1970)|\(course)"
            let id = "wlsaplus.class." + Self.stableHash(identity)
            guard scheduled.insert(id).inserted else { continue }
            desired.append(id)
            let content = UNMutableNotificationContent()
            content.title = "\(course) starts in 5 minutes"
            let room = entry.item["room"] as? String ?? ""
            let teacher = entry.item["teacher"] as? String ?? ""
            content.body = [room.isEmpty ? "" : "Room: \(room)", teacher].filter { !$0.isEmpty }.joined(separator: " · ")
            content.sound = .default
            content.userInfo = ["page": "schedule"]
            if let old = pending.first(where: { $0.identifier == id }), old.content.title == content.title, old.content.body == content.body { continue }
            var components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: entry.fire)
            components.timeZone = TimeZone.current
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
            if epoch != reminderGeneration && !desiredReminderIDs.contains(id) { center.removePendingNotificationRequests(withIdentifiers: [id]) }
        }
        guard epoch == reminderGeneration else { return }
        let allPending = await center.pendingNotificationRequests()
        guard epoch == reminderGeneration else { return }
        center.removePendingNotificationRequests(withIdentifiers: allPending.map(\.identifier).filter { $0.hasPrefix("wlsaplus.class.") && !scheduled.contains($0) })
        try store.set("reminderIDs", desired)
    }
    private func clearClassReminders(_ center: UNUserNotificationCenter, epoch: Int, previousIDs: [String]) async throws {
        let pending = await center.pendingNotificationRequests()
        let delivered = await center.deliveredNotifications()
        guard epoch == reminderGeneration else { return }
        let ids = Set(previousIDs + pending.map(\.identifier).filter { $0.hasPrefix("wlsaplus.class.") } + delivered.map { $0.request.identifier }.filter { $0.hasPrefix("wlsaplus.class.") })
        center.removePendingNotificationRequests(withIdentifiers: Array(ids))
        center.removeDeliveredNotifications(withIdentifiers: Array(ids))
        try store.set("reminderIDs", [String]())
    }
    private static func stableHash(_ value: String) -> String {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in value.utf8 { hash = (hash ^ UInt64(byte)) &* 1_099_511_628_211 }
        return String(hash, radix: 16)
    }
    private static func isoDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let result = formatter.date(from: value) { return result }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    func saveSettings(_ args: [String: Any]) async throws -> [String: Any] {
        var patch = args
        if let hex = patch["accent"] as? String, hex.hasPrefix("#") {
            guard let name = Self.accentHex.first(where: { $0.value.caseInsensitiveCompare(hex) == .orderedSame })?.key else { throw AppError("Choose an available accent color.") }
            patch["accent"] = name
        }
        for key in ["reminders", "autostart", "tuningEnabled"] where patch[key] != nil {
            guard patch[key] is Bool else { throw AppError("Invalid \(key) setting.") }
        }
        if let time = patch["tunedTime"] as? String, !time.isEmpty, Self.isoDate(time) == nil { throw AppError("Choose a valid display time.") }
        let previous = store.value, previousAutostart = previous["autostart"] as? Bool ?? false
        let desiredAutostart = patch["autostart"] as? Bool ?? previousAutostart
        do {
            if desiredAutostart != previousAutostart {
                if desiredAutostart {
                    try SMAppService.mainApp.register()
                    guard SMAppService.mainApp.status == .enabled else { throw AppError("Enable WLSAPlus in System Settings → General → Login Items, then try again.") }
                } else { try await SMAppService.mainApp.unregister() }
            }
            try store.settings(patch)
            if patch["reminders"] != nil { try await scheduleReminders() }
        } catch {
            // Roll back only this settings patch; an intervening school sync or to-do save survives.
            let settingKeys: Set<String> = ["appearance", "accent", "reminders", "autostart", "tuningEnabled", "tunedTime", "channel"]
            var rollback = store.value
            for key in patch.keys where settingKeys.contains(key) { rollback[key] = previous[key] }
            try? store.replace(rollback)
            if desiredAutostart != previousAutostart {
                if previousAutostart { try? SMAppService.mainApp.register() }
                else { try? await SMAppService.mainApp.unregister() }
            }
            throw error
        }
        applyWindowAppearance()
        await updateForumTheme()
        refreshMap()
        let names: Set<String> = ["appearance", "accent", "reminders", "autostart", "tuningEnabled", "tunedTime", "channel"]
        let result = store.value.filter { names.contains($0.key) }
        emit("settings", result)
        return result
    }
    func restoreAppearance() {
        applyWindowAppearance()
    }
    private func applyWindowAppearance() {
        let value = store.value["appearance"] as? String ?? "system"
        let appearance: NSAppearance? = value == "dark" ? NSAppearance(named: .darkAqua) : value == "light" ? NSAppearance(named: .aqua) : nil
        NSApp.appearance = appearance
        for window in NSApp.windows { window.appearance = appearance }
    }
    private var theme: String {
        let value = store.value["appearance"] as? String ?? "system"
        if value == "dark" || value == "light" { return value }
        return NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? "dark" : "light"
    }
    private func emit(_ name: String, _ value: Any) { onChange?(["name": name, "value": value]) }

    func openForum(parent: NSWindow) async throws -> [String: Any] {
        if forumOpening { throw AppError("The forum is already opening.") }
        forumOpening = true
        defer { forumOpening = false }
        let epoch = forumGeneration
        let webView = makeForum(parent: parent)
        await updateForumTheme()
        guard epoch == forumGeneration else { throw CancellationError() }
        var destination = ForumPolicy.entry(theme: theme)
        var message = "Forum opened as a guest. Connect and sync PowerSchool to sign in."
        if school.account["username"] as? String != nil {
            do { destination = try await forumSignIn(); message = "Forum sign-in requested using your current PowerSchool session." }
            catch is CancellationError { throw CancellationError() }
            catch { message = "Forum opened as a guest because PowerSchool session sign-in was unavailable. Sync PowerSchool and try again." }
        }
        guard epoch == forumGeneration else { throw CancellationError() }
        forumStatus?.stringValue = message
        forumWindow?.makeKeyAndOrderFront(nil)
        webView.load(URLRequest(url: destination))
        emit("forum", ["message": message])
        return ["message": message, "opened": true]
    }
    private func forumSignIn() async throws -> URL {
        guard let address = school.account["baseURL"] as? String, let schoolURL = URL(string: address), schoolURL.scheme == "https", let host = schoolURL.host,
              let cookies = school.cookies?.cookies(for: schoolURL) else { throw AppError("A current school session is needed.") }
        let whitelist: Set<String> = ["JSESSIONID", "psaid", "sl-session", "current_locale", "uiStateCookie"]
        let selected = cookies.filter { cookie in
            let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
            return whitelist.contains(cookie.name) && !cookie.value.isEmpty && (host.lowercased() == domain || host.lowercased().hasSuffix("." + domain)) && (cookie.expiresDate == nil || cookie.expiresDate! > Date())
        }
        guard selected.contains(where: { ["JSESSIONID", "psaid", "sl-session"].contains($0.name) }) else { throw AppError("The school session has expired.") }
        var request = URLRequest(url: ForumPolicy.origin.appendingPathComponent("sso/wlsaplus/issue"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try jsonData(["cookies": selected.map { ["name": $0.name, "value": $0.value, "domain": $0.domain] }, "schoolUrl": address, "next": "/?embed=wlsaplus&theme=\(theme)"])
        let body = try jsonObject(await bounded(request, maximum: 64 * 1024), maximum: 64 * 1024)
        guard let value = body["url"] as? String else { throw AppError("The forum returned no sign-in address.") }
        return try ForumPolicy.consumptionURL(value)
    }
    private func makeForum(parent: NSWindow) -> WKWebView {
        if let forumView { return forumView }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = forumStore
        // No WKScriptMessageHandler is installed in this untrusted remote web view.
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.translatesAutoresizingMaskIntoConstraints = false
        view.allowsBackForwardNavigationGestures = true
        let navigation = ForumNavigation()
        navigation.failure = { [weak self] message in self?.forumStatus?.stringValue = message; self?.emit("forum", ["message": message]) }
        navigation.loaded = { [weak self] in Task { @MainActor [weak self] in await self?.updateForumTheme() } }
        view.navigationDelegate = navigation
        view.uiDelegate = navigation
        forumNavigation = navigation
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1050, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "WLSAPlus Forum"
        window.minSize = NSSize(width: 620, height: 440)
        window.isReleasedWhenClosed = false
        let container = NSView()
        let status = NSTextField(labelWithString: "Opening forum…")
        status.font = .systemFont(ofSize: 11)
        status.textColor = .secondaryLabelColor
        status.lineBreakMode = .byTruncatingTail
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let controls = NSStackView()
        controls.orientation = .horizontal
        controls.spacing = 8
        controls.translatesAutoresizingMaskIntoConstraints = false
        controls.addArrangedSubview(NSButton(title: "Back", target: self, action: #selector(forumBack)))
        controls.addArrangedSubview(NSButton(title: "Forward", target: self, action: #selector(forumForward)))
        controls.addArrangedSubview(NSButton(title: "Reload", target: self, action: #selector(forumReload)))
        controls.addArrangedSubview(status)
        controls.addArrangedSubview(NSButton(title: "Open in browser", target: self, action: #selector(forumExternal)))
        container.addSubview(controls)
        container.addSubview(view)
        NSLayoutConstraint.activate([
            controls.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12), controls.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12), controls.topAnchor.constraint(equalTo: container.topAnchor, constant: 9), controls.heightAnchor.constraint(equalToConstant: 30),
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor), view.trailingAnchor.constraint(equalTo: container.trailingAnchor), view.topAnchor.constraint(equalTo: controls.bottomAnchor, constant: 9), view.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
        window.contentView = container
        window.center()
        window.setFrameOrigin(NSPoint(x: parent.frame.midX - window.frame.width / 2, y: parent.frame.midY - window.frame.height / 2))
        forumWindow = window; forumView = view; forumStatus = status
        return view
    }
    @objc private func forumBack() { forumView?.goBack() }
    @objc private func forumForward() { forumView?.goForward() }
    @objc private func forumReload() { forumView?.reload() }
    @objc private func forumExternal() { NSWorkspace.shared.open(ForumPolicy.entry(theme: theme)) }
    private func updateForumTheme() async {
        let current = theme
        for host in ForumPolicy.hosts {
            for (name, value) in [("wlsaplus_theme", current), ("wlsaplus_embed", "1")] {
                if let cookie = HTTPCookie(properties: [.domain: host, .path: "/", .name: name, .value: value, .secure: "TRUE", .expires: Date().addingTimeInterval(365 * 86400)]) {
                    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in forumStore.httpCookieStore.setCookie(cookie) { continuation.resume() } }
                }
            }
        }
        guard let view = forumView else { return }
        let encoded = String(data: (try? jsonData(["type": "wlsaplus-theme", "theme": current])) ?? Data(), encoding: .utf8) ?? "{}"
        let script = "document.documentElement.style.colorScheme = '\(current)'; window.postMessage(\(encoded), location.origin);"
        view.configuration.userContentController.removeAllUserScripts()
        view.configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if let url = view.url, ForumPolicy.approved(url) { _ = try? await view.evaluateJavaScript(script) }
    }
    func clearForum() async {
        forumGeneration += 1
        forumView?.stopLoading()
        forumWindow?.close()
        forumView?.navigationDelegate = nil; forumView?.uiDelegate = nil
        forumView = nil; forumWindow = nil; forumNavigation = nil; forumStatus = nil
        let old = forumStore
        forumStore = WKWebsiteDataStore.nonPersistent()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in old.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { continuation.resume() } }
    }

    func fetchNotice() async {
        do {
            let data = try await bounded(URLRequest(url: URL(string: "https://wlsaplus.spacehubxyz.hk/notice.json")!), maximum: 64 * 1024)
            let value = try jsonObject(data, maximum: 64 * 1024)
            guard let id = (value["id"] as? String) ?? (value["id"] as? NSNumber)?.stringValue, !id.isEmpty, id.count <= 128,
                  let title = value["title"] as? String, title.count <= 256,
                  let content = value["content"] as? String, content.count <= 20_000 else { return }
            let kind = value["type"] as? String ?? "info"
            let normalized: [String: Any] = ["id": id, "title": title, "content": content, "type": ["info", "warning", "success", "error"].contains(kind) ? kind : "info"]
            notice = normalized
            try? store.set("notice", normalized)
            emit("notice", normalized)
        } catch { /* An offline launch retains only the last real, validated notice. */ }
    }

    private struct CampusBuilding {
        let number: Int, name: String, details: String
    }
    private static let campus: [CampusBuilding] = [
        .init(number: 1, name: "Sports hall", details: "Sports hall."),
        .init(number: 2, name: "Cloud library & offices", details: "Cloud library and offices."),
        .init(number: 3, name: "Teaching building", details: "Teaching building."),
        .init(number: 4, name: "Golf", details: "Golf facilities."),
        .init(number: 5, name: "Seven Cube · Teaching & dining", details: "Seven Cube teaching building and Dining Hall 1."),
        .init(number: 6, name: "Seven Cube · Classrooms & student center", details: "Seven Cube classrooms and student center."),
        .init(number: 7, name: "Girls’ dormitory", details: "Girls’ dormitory."),
        .init(number: 8, name: "Boys’ dormitory", details: "Boys’ dormitory."),
        .init(number: 9, name: "Teaching & student services", details: "1F: IT and faculty offices. 2F: Innovation. 3F: Students. 4F: Counseling. 6F: Test center."),
        .init(number: 10, name: "Boys’ dormitory & dining", details: "Boys’ dormitory and Dining Hall 2."),
        .init(number: 11, name: "Classrooms & girls’ dormitory", details: "1F: Classrooms. 2–4F: Girls’ dormitory."),
        .init(number: 12, name: "Fitness & pickleball", details: "1F: Fitness. 2F: Pickleball.")
    ]
    static func buildingNumber(_ room: String) -> Int? {
        let value = room.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return nil }
        func capture(_ pattern: String) -> Int? {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]), let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)), let range = Range(match.range(at: 1), in: value) else { return nil }
            return Int(value[range])
        }
        // A two-digit building requires an explicit label or separator. 1201 means Building 1.
        if let explicit = capture(#"(?:building|bldg\.?)\s*(1[0-2]|[1-9])(?:\b|[-–—])"#) { return explicit }
        if let separated = capture(#"^(1[0-2]|[1-9])\s*[-–—]\s*[0-9]+$"#) { return separated }
        if let standalone = Int(value), (1...12).contains(standalone) { return standalone }
        if let ordinary = capture(#"^([1-9])[0-9]{2,4}$"#) { return ordinary }
        return nil
    }
    func openMap(room: String) throws -> [String: Any] {
        guard room.count <= 100 else { throw AppError("Keep the room name under 100 characters.") }
        mapQuery = room.trimmingCharacters(in: .whitespacesAndNewlines)
        mapSelection = Self.buildingNumber(mapQuery)
        if mapView == nil {
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            let view = WKWebView(frame: .zero, configuration: configuration)
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "WLSAPlus · Campus building directory"
            window.minSize = NSSize(width: 550, height: 420)
            window.isReleasedWhenClosed = false
            window.contentView = view
            window.center()
            mapWindow = window; mapView = view
        }
        refreshMap()
        mapWindow?.makeKeyAndOrderFront(nil)
        let building = Self.campus.first { $0.number == mapSelection }
        let message = building.map { "Building \($0.number): \($0.name)." } ?? (mapQuery.isEmpty ? "Campus building directory opened." : "No building could be inferred from that room. The campus directory is open; use a room such as 5218 or an explicit building such as 12-201.")
        return ["building": building.map { $0.number as Any } ?? NSNull(), "name": building?.name ?? "Campus building directory", "details": building?.details ?? "Twelve numbered campus buildings. This is a directory, not a floor plan or walking route.", "message": message]
    }
    private func refreshMap() {
        guard let view = mapView else { return }
        let dark = theme == "dark", background = dark ? "#14191f" : "#f5f7f8", surface = dark ? "#202832" : "#ffffff", foreground = dark ? "#e8edf2" : "#20303b", secondary = dark ? "#aab6c4" : "#687887"
        let accent = Self.accentHex[store.value["accent"] as? String ?? "default"] ?? "#00677a"
        let selected = Self.campus.first { $0.number == mapSelection }
        let focus = selected.map { "<section class='selected'><span>ROOM LOOKUP · BUILDING \($0.number)</span><h2>\(Self.html($0.name))</h2><p>\(Self.html($0.details))</p></section>" } ?? ""
        let cards = Self.campus.map { building in "<a class='building \(building.number == mapSelection ? "active" : "")' id='building-\(building.number)' href='#building-\(building.number)'><b>\(building.number)</b><div><h2>\(Self.html(building.name))</h2><p>\(Self.html(building.details))</p></div></a>" }.joined()
        // Original numbered schematic. The ordering makes no claim about physical coordinates.
        let html = """
        <!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"><title>Campus building directory</title><style>
        :root{color-scheme:\(dark ? "dark" : "light");font-family:-apple-system,system-ui,sans-serif;color:\(foreground);background:\(background);font-size:14px;line-height:1.6}*{box-sizing:border-box}body{max-width:1200px;margin:auto;padding:34px}header{margin-bottom:25px}small,header>p{color:\(secondary)}small{font-size:10px;letter-spacing:1.5px}h1{font-size:29px;letter-spacing:-1px;margin:8px 0}header>p{max-width:720px;font-size:12px}.selected{background:\(accent);color:white;border-radius:14px;padding:22px 25px;margin-bottom:22px}.selected>span{font-size:10px;letter-spacing:1px}.selected h2{font-size:20px;margin:8px 0}.selected p{margin:0;font-size:13px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.building{display:flex;gap:14px;align-items:flex-start;background:\(surface);color:\(foreground);padding:20px;border-radius:13px;border:2px solid transparent;text-decoration:none;scroll-margin:20px}.building:target,.building.active,.building:focus-visible{border-color:\(accent);outline:none}.building>b{display:grid;place-items:center;min-width:34px;height:34px;border-radius:10px;color:\(accent);background:\(background);font-size:18px;font-weight:600}.building h2{font-size:13px;margin:2px 0 6px;line-height:1.5}.building p{font-size:11px;color:\(secondary);margin:0}footer{font-size:11px;color:\(secondary);margin-top:25px;border-top:1px solid \(secondary);padding-top:16px}@media(max-width:800px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}body{padding:25px}}@media(max-width:500px){.grid{grid-template-columns:1fr}}
        </style></head><body><header><small>WLSAPLUS · CAMPUS</small><h1>Your campus, building by building.</h1><p>Find a numbered building and its facilities. This original schematic is a building directory. Card positions do not represent geographic coordinates, and no classroom position or walking route is inferred.</p></header>\(focus)<main class="grid" aria-label="Numbered campus building directory">\(cards)</main><footer>Room convention: 5218 → Building 5. Use Building12 or 12-201 for Building 12; 1201 → Building 1. Floor details are shown only where supplied by the campus directory.</footer></body></html>
        """
        view.loadHTMLString(html, baseURL: nil)
    }
    private static func html(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&#39;")
    }
}
