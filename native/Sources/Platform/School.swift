import Foundation
import Security

enum PasswordVault {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: AppIdentity.bundle + ".native.account", kSecAttrAccount as String: "powerschool"]
    }
    static func read() throws -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var object: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &object)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = object as? Data, let text = String(data: data, encoding: .utf8) else { throw AppError("Could not open the saved password in Keychain.") }
        return text
    }
    static func write(_ password: String) throws {
        let attributes = [kSecValueData as String: Data(password.utf8)]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var q = query.merging(attributes) { _, new in new }
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw AppError("Could not save the password in Keychain.") }
        } else if status != errSecSuccess { throw AppError("Could not update the saved password.") }
    }
    static func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw AppError("Could not delete the saved password.") }
    }
}

private final class SchoolRedirects: NSObject, URLSessionTaskDelegate {
    let origin: URL
    init(_ origin: URL) { self.origin = origin }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port else { completionHandler(nil); return }
        completionHandler(request)
    }
}

@MainActor final class SchoolService {
    typealias Parser = (String, [String: Any]) async throws -> [String: Any]
    let store: LocalState
    var parser: Parser!
    private(set) var session: URLSession?
    private(set) var cookies: HTTPCookieStorage?
    private var generation = 0
    private var busy = false
    init(store: LocalState) { self.store = store }
    var account: [String: Any] { store.value["school"] as? [String: Any] ?? [:] }
    func login(_ input: [String: Any]) async throws -> [String: Any] {
        guard !busy else { throw AppError("A school connection is already in progress.") }
        guard let base = input["baseURL"] as? String, let user = input["username"] as? String,
              let password = input["password"] as? String, !user.trimmingCharacters(in: .whitespaces).isEmpty, !password.isEmpty,
              let candidate = URLComponents(string: base.contains("://") ? base : "https://" + base), candidate.scheme == "https", candidate.host != nil,
              candidate.user == nil, candidate.password == nil else { throw AppError("Enter a valid HTTPS school address, username and password.") }
        var components = candidate
        components.path = ""; components.query = nil; components.fragment = nil
        guard let origin = components.url else { throw AppError("Invalid school address.") }
        busy = true; generation += 1; let epoch = generation
        defer { busy = false }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 25
        configuration.timeoutIntervalForResource = 60
        configuration.httpCookieAcceptPolicy = .always
        let connection = URLSession(configuration: configuration, delegate: SchoolRedirects(origin), delegateQueue: nil)
        func current() throws { if generation != epoch { throw CancellationError() } }
        do {
            let loginHTML = try await request(connection, origin: origin, path: "/public/")
            try current()
            let parsed = try await parser("fields", ["html": loginHTML])
            var fields = parsed["fields"] as? [String: String] ?? [:]
            // Form field names are the server's public sign-in contract.
            fields["account"] = user.trimmingCharacters(in: .whitespaces)
            fields["pw"] = password; fields["dbpw"] = password
            fields["translator_username"] = ""; fields["translator_password"] = ""; fields["translator_ldappassword"] = ""; fields["translatorpw"] = ""
            fields["serviceName"] = fields["serviceName"] ?? "PS Parent Portal"
            fields["pcasServerUrl"] = fields["pcasServerUrl"] ?? "/"
            fields["credentialType"] = fields["credentialType"] ?? "User Id and Password Credential"
            let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
            let body = fields.keys.sorted().map { key in (key.addingPercentEncoding(withAllowedCharacters: allowed) ?? "") + "=" + (fields[key]!.addingPercentEncoding(withAllowedCharacters: allowed) ?? "") }.joined(separator: "&")
            let home = try await request(connection, origin: origin, path: "/guardian/home.html", method: "POST", body: Data(body.utf8), contentType: "application/x-www-form-urlencoded")
            try current()
            let status = try await parser("fields", ["html": home])
            guard status["signIn"] as? Bool != true else { throw AppError("Sign in failed. Check your school address and credentials.") }
            async let week = request(connection, origin: origin, path: "/guardian/myschedule.html")
            async let matrix = request(connection, origin: origin, path: "/guardian/myschedulematrix.html")
            async let attendance = request(connection, origin: origin, path: "/guardian/attendance.html")
            let (w, m) = try await (week, matrix)
            let a = (try? await attendance) ?? ""
            try current()
            let snapshot = try await parser("snapshot", ["week": w, "matrix": m, "home": home, "attendance": a])
            try current()
            let previousPassword = try PasswordVault.read()
            try PasswordVault.write(password)
            do {
                var next = store.value
                next["school"] = ["baseURL": origin.absoluteString, "username": fields["account"]!]
                next["snapshot"] = snapshot
                // One atomic account/snapshot commit; old-account records never mix with new cookies.
                try store.replace(next)
            } catch {
                if let previousPassword { try? PasswordVault.write(previousPassword) } else { try? PasswordVault.remove() }
                throw error
            }
            session?.invalidateAndCancel()
            session = connection; cookies = configuration.httpCookieStorage
            return snapshot
        } catch { connection.invalidateAndCancel(); throw error }
    }
    func sync() async throws -> [String: Any] {
        guard let password = try PasswordVault.read(), let base = account["baseURL"], let user = account["username"] else { throw AppError("Connect to PowerSchool first.") }
        return try await login(["baseURL": base, "username": user, "password": password])
    }
    func logout() throws {
        generation += 1
        session?.invalidateAndCancel(); session = nil; cookies = nil
        try PasswordVault.remove()
        try store.set("school", nil)
        try store.set("snapshot", ["courses": [], "schedule": [], "assignments": [], "attendance": []])
    }
    func course(_ id: String) async throws -> [String: Any] {
        guard !busy else { throw AppError("Wait for the school synchronization to finish before loading course details.") }
        let epoch = generation
        guard let session, let base = account["baseURL"] as? String, let origin = URL(string: base),
              var snapshot = store.value["snapshot"] as? [String: Any],
              let courses = snapshot["courses"] as? [[String: Any]], let course = courses.first(where: { $0["id"] as? String == id }) else { throw AppError("Refresh the school connection before opening this course.") }
        guard let path = course["detailsPath"] as? String, let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              url.host == origin.host, url.scheme == origin.scheme, url.port == origin.port, url.path == "/guardian/scores.html" else { throw AppError("This course has no assignment details page.") }
        let html = try await request(session, origin: origin, path: url.absoluteString)
        var details = try await parser("details", ["html": html, "assignments": []])
        if let lookup = details["lookup"] as? [String: Any] {
            let json = try await request(session, origin: origin, path: "/ws/xte/assignment/lookup", method: "POST", body: jsonData(lookup), contentType: "application/json;charset=UTF-8", referrer: url)
            guard let raw = json.data(using: .utf8), let assignments = try JSONSerialization.jsonObject(with: raw) as? [Any] else { throw AppError("Invalid assignment response.") }
            details = try await parser("details", ["html": html, "assignments": assignments])
        }
        guard generation == epoch else { throw CancellationError() }
        if let latest = store.value["snapshot"] as? [String: Any] { snapshot = latest }
        if var assignments = details["assignments"] as? [[String: Any]] {
            for i in assignments.indices { assignments[i]["course"] = course["name"]; assignments[i]["courseId"] = id }
            let old = snapshot["assignments"] as? [[String: Any]] ?? []
            snapshot["assignments"] = old.filter { $0["courseId"] as? String != id } + assignments
            try store.set("snapshot", snapshot)
        }
        details["lookup"] = nil
        return details
    }
    private func request(_ session: URLSession, origin: URL, path: String, method: String = "GET", body: Data? = nil, contentType: String? = nil, referrer: URL? = nil) async throws -> String {
        guard let url = URL(string: path, relativeTo: origin)?.absoluteURL, url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port else { throw AppError("Refusing a request outside the school server.") }
        var request = URLRequest(url: url)
        request.httpMethod = method; request.httpBody = body
        request.setValue("WLSAPlus/\(AppIdentity.version)", forHTTPHeaderField: "User-Agent")
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let referrer { request.setValue(referrer.absoluteString, forHTTPHeaderField: "Referer") }
        let (data, response) = try await boundedResponse(request, session: session, maximum: 4 * 1024 * 1024)
        guard response.url?.scheme == origin.scheme, response.url?.host == origin.host, response.url?.port == origin.port else { throw AppError("The school redirected outside its trusted origin.") }
        guard let text = String(data: data, encoding: .utf8) else { throw AppError("The school returned an unsupported text encoding.") }
        return text
    }
}
