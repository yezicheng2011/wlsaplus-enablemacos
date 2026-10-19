import AppKit
import WebKit

@main struct Program {
    @MainActor static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        do {
            if arguments.first == "--vpn-helper", arguments.count == 2 { try VPNHelper.run(configURL: URL(fileURLWithPath: arguments[1])); return }
            if arguments.first == "--vpn-helper-launch", arguments.count == 2 { try VPNHelper.launch(configURL: URL(fileURLWithPath: arguments[1])); return }
            if arguments.first == "--vpn-helper-recover", arguments.count == 1 { try VPNHelper.recover(); return }
            if arguments.first == "--native-installer" { try UpdateInstaller.perform(arguments); return }
            if arguments.first == "--make-manifest" { try ManifestPublisher.perform(Array(arguments.dropFirst())); return }
            let app = NSApplication.shared
            app.setActivationPolicy(.regular)
            let delegate = try ApplicationDelegate()
            app.delegate = delegate
            withExtendedLifetime(delegate) { app.run() }
        } catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }
}

@MainActor final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    let store: LocalState
    let school: SchoolService
    let updater: NativeUpdater
    let vpn: VPNService
    let services: UserServices
    var window: NSWindow!
    var browser: BrowserHost!
    private var quitting = false
    private var quitApproved = false
    init(stateDirectory: URL = AppIdentity.support) throws {
        let previousRunning = NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == AppIdentity.bundle && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        store = try LocalState(directory: stateDirectory, allowLegacyMigration: !previousRunning)
        school = SchoolService(store: store)
        updater = NativeUpdater(store: store)
        vpn = VPNService(store: store)
        services = UserServices(store: store, school: school)
        super.init()
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            guard let resources = Bundle.main.resourceURL else { throw AppError("The application's resources are missing.") }
            browser = try BrowserHost(resources: resources)
            school.parser = { [weak self] kind, value in
                guard let self else { throw CancellationError() }
                return try await self.browser.parse(kind, value)
            }
            browser.invoke = { [weak self] method, args in
                guard let self else { throw CancellationError() }
                return try await self.invoke(method, args)
            }
            browser.onReady = { [weak self] in
                guard let self else { return }
                do { try UpdateInstaller.acknowledge(arguments: CommandLine.arguments) }
                catch { self.present(error) }
                self.browser.event("state", self.state())
                if let migration = self.store.value["migration"] as? [String: Any], migration["status"] as? String == "pending", let message = migration["message"] {
                    self.browser.event("notification", ["message": message])
                }
                if CommandLine.arguments.contains("--wlsaplus-update-verify-only") { self.quitApproved = true; NSApp.terminate(nil) }
            }
            vpn.onChange = { [weak self] value in self?.browser.event("vpn", value) }
            updater.onChange = { [weak self] value in self?.browser.event("update", value) }
            updater.disconnect = { [weak self] in _ = try await self?.vpn.disconnect() }
            services.onChange = { [weak self] value in
                if let name = value["name"] as? String, let data = value["value"] { self?.browser.event(name, data) }
            }
            window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.title = "WLSAPlus"; window.minSize = NSSize(width: 520, height: 580); window.center()
            window.contentView = browser.webView; window.setFrameAutosaveName("WLSAPlus.main")
            createMenu()
            if !CommandLine.arguments.contains("--autostart") && !CommandLine.arguments.contains("--wlsaplus-update-verify-only") {
                window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
            }
            updater.begin()
            Task { await services.fetchNotice(); try? await services.scheduleReminders() }
        } catch { present(error); quitApproved = true; NSApp.terminate(nil) }
    }
    private func createMenu() {
        let menu = NSMenu(), item = NSMenuItem(), appMenu = NSMenu()
        appMenu.addItem(withTitle: "About WLSAPlus", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit WLSAPlus", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu; menu.addItem(item)
        let editItem = NSMenuItem(), edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit; menu.addItem(editItem); NSApp.mainMenu = menu
    }
    func state() -> [String: Any] {
        var state = store.value
        state["version"] = AppIdentity.version; state["vpn"] = vpn.status; state["update"] = updater.status
        if let notice = services.notice { state["notice"] = notice }
        return state
    }
    private func invoke(_ method: String, _ args: [String: Any]) async throws -> Any {
        switch method {
        case "app.state": return state()
        case "settings.save":
            let previousChannel = updater.beta
            let settings = try await services.saveSettings(args)
            if previousChannel != updater.beta { updater.channelChanged() }
            browser.event("state", state()); return settings
        case "school.login", "school.sync":
            let previous = school.account["username"] as? String
            let snapshot = method == "school.login" ? try await school.login(args) : try await school.sync()
            if previous != school.account["username"] as? String { await services.clearForum() }
            do { try await services.scheduleReminders() }
            catch { browser.event("notification", ["message": error.localizedDescription]) }
            browser.event("state", state()); return snapshot
        case "school.logout":
            try school.logout(); await services.clearForum(); try? await services.scheduleReminders(); browser.event("state", state()); return state()
        case "school.course":
            let result = try await school.course(args["id"] as? String ?? "")
            browser.event("snapshot", store.value["snapshot"] ?? [:]); return result
        case "todos.save":
            guard let items = args["items"] as? [[String: Any]], items.count <= 5000 else { throw AppError("Invalid to-do list.") }
            for item in items {
                guard let title = item["title"] as? String, title.count <= 2000, let id = item["id"] as? String, id.count <= 256 else { throw AppError("Invalid task.") }
            }
            try store.set("todos", items); browser.event("todos", items); return ["items": items]
        case "translate": return try await services.translate(args)
        case "forum.open": return try await services.openForum(parent: window)
        case "map.open": return try services.openMap(room: args["room"] as? String ?? "")
        case "vpn.nodes": return try await vpn.nodes()
        case "vpn.connect": return try await vpn.connect(nodeId: args["nodeId"] as? String ?? "")
        case "vpn.disconnect": return try await vpn.disconnect()
        case "vpn.latency": return try await vpn.latency()
        case "vpn.wechat": return try await vpn.wechat()
        case "updates.check": updater.check(); return updater.status
        case "updates.install": try await updater.install(); return updater.status
        case "updates.log":
            NSWorkspace.shared.activateFileViewerSelecting([updater.directory.appendingPathComponent("update.log")]); return ["ok": true]
        case "external.open":
            guard let raw = args["url"] as? String, let url = URL(string: raw), ["https", "http"].contains(url.scheme ?? ""), url.user == nil, url.password == nil else { throw AppError("This link is not allowed.") }
            NSWorkspace.shared.open(url); return ["ok": true]
        case "app.clear", "data.clear":
            _ = try await vpn.disconnect(); try school.logout(); await services.clearForum(); try store.clear(); try? await services.scheduleReminders(); browser.event("state", state()); return state()
        default: throw AppError("Unknown native operation: \(method)")
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitApproved || updater.status["state"] as? String == "installing" { return .terminateNow }
        guard !quitting else { return .terminateCancel }
        quitting = true
        Task {
            do {
                _ = try await vpn.disconnect()
                if updater.status["state"] as? String == "ready" { try await updater.install(restart: false) }
                quitApproved = true; sender.reply(toApplicationShouldTerminate: true)
            } catch { quitting = false; present(error); sender.reply(toApplicationShouldTerminate: false) }
        }
        return .terminateLater
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window?.makeKeyAndOrderFront(nil); return true }
    private func present(_ error: Error) {
        let alert = NSAlert(); alert.messageText = "WLSAPlus"; alert.informativeText = error.localizedDescription; alert.runModal()
    }
}
