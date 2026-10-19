import AppKit
import WebKit

final class BundleScheme: NSObject, WKURLSchemeHandler {
    private let root: URL
    init(root: URL) { self.root = root.resolvingSymlinksInPath() }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        do {
            guard let url = urlSchemeTask.request.url, url.scheme == "wlsa", url.host == "ui", url.user == nil, url.password == nil else { throw AppError("Invalid local resource.") }
            let relative = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
            let file = root.appendingPathComponent(relative).resolvingSymlinksInPath()
            guard file.path.hasPrefix(root.path + "/"), !relative.split(separator: "/").contains(".."), FileManager.default.fileExists(atPath: file.path) else { throw AppError("Local resource not found.") }
            let mime = ["html": "text/html", "css": "text/css", "js": "application/javascript", "svg": "image/svg+xml", "png": "image/png"][file.pathExtension] ?? "application/octet-stream"
            let bytes = try Data(contentsOf: file)
            let headers = ["Content-Type": mime + (mime.hasPrefix("text/") || file.pathExtension == "js" ? "; charset=utf-8" : ""),
                           "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
                           "X-Content-Type-Options": "nosniff"]
            urlSchemeTask.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
            urlSchemeTask.didReceive(bytes); urlSchemeTask.didFinish()
        } catch { urlSchemeTask.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

@MainActor final class BrowserHost: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let webView: WKWebView
    var onReady: (() -> Void)?
    var invoke: ((String, [String: Any]) async throws -> Any)?
    private var pending = Set<String>()
    init(resources: URL) throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(BundleScheme(root: resources), forURLScheme: "wlsa")
        let content = WKUserContentController()
        let parser = try String(contentsOf: resources.appendingPathComponent("school-parser.js"), encoding: .utf8)
        content.addUserScript(WKUserScript(source: parser, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController = content
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        content.add(self, name: "wlsaplus")
        webView.navigationDelegate = self
        webView.load(URLRequest(url: URL(string: "wlsa://ui/index.html")!))
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === webView, message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.scheme == "wlsa", message.frameInfo.request.url?.host == "ui",
              let body = message.body as? [String: Any],
              let rawID = body["id"], rawID is String || rawID is NSNumber,
              let method = body["method"] as? String, method.utf8.count < 100,
              pending.count < 64 else { return }
        let id = String(describing: rawID)
        guard pending.insert(id).inserted else { return }
        let arguments = body["args"] as? [String: Any] ?? [:]
        Task {
            defer { pending.remove(id) }
            do {
                guard let invoke else { throw AppError("Native services are not ready.") }
                let result = try await invoke(method, arguments)
                await reply(["id": rawID, "result": result])
            } catch { await reply(["id": rawID, "error": error.localizedDescription]) }
        }
    }
    private func reply(_ object: [String: Any]) async {
        guard let data = try? jsonData(object), let encoded = String(data: data, encoding: .utf8) else { return }
        _ = try? await webView.evaluateJavaScript("window.nativeReply(\(encoded))")
    }
    func event(_ name: String, _ value: Any) {
        guard let data = try? jsonData(["name": name, "value": value]), let encoded = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.nativeEvent(\(encoded))", completionHandler: nil)
    }
    func parse(_ kind: String, _ value: [String: Any]) async throws -> [String: Any] {
        let response = try await webView.callAsyncJavaScript("return window.schoolParser(kind, data)", arguments: ["kind": kind, "data": value], in: nil, in: .page)
        guard let parsed = response as? [String: Any] else { throw AppError("The school page could not be parsed.") }
        return parsed
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, url.scheme == "wlsa", url.host == "ui", navigationAction.targetFrame?.isMainFrame != false else { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onReady?() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let alert = NSAlert(); alert.messageText = "WLSAPlus could not load its interface"; alert.informativeText = error.localizedDescription; alert.runModal()
    }
}
