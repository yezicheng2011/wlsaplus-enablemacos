import Foundation
import Dispatch
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// A root-owned, crash-recoverable route and DNS transaction. All system command
/// arguments are arrays. A journal never contains executable commands or secrets.
final class NetworkPlan {
    private struct Route: Codable {
        var family: Int
        var destination: String
        var prefix: Int
        var gateway: String?
        var interface: String
        // 0: untouched, 1: command may have run, 2: added, 3: restored.
        var state: Int = 0
        var host: Bool { prefix == (family == 4 ? 32 : 128) }
        var target: String { host ? destination : "\(destination)/\(prefix)" }
    }
    private struct Service: Codable {
        var name: String
        var dns: [String]
        var state: Int = 0
    }
    private struct Journal: Codable {
        var version = 1
        var interface: String
        var routes: [Route]
        var services: [Service]
    }
    private struct RouteInfo {
        let fields: [String: String]
        var interface: String { fields["interface"] ?? "" }
        var gateway: String? { fields["gateway"] }
        var flags: Set<String> {
            Set((fields["flags"] ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "<>")).split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).uppercased() })
        }
    }
    private let interface: String
    private let nodeAddresses: [String]
    private let journalURL: URL
    private var storage: RecoveryStorage?
    private var journal: Journal?
    #if NATIVE_INTEGRATION_TESTS
    private(set) var verificationFailureClass: String?
    private(set) var setupStage = "storage"
    private(set) var setupRouteFlags = [String]()
    private(set) var setupInterfaceClass = "missing"
    #endif
    private static let tunnelDNS = ["1.1.1.1", "8.8.8.8"]
    #if NETWORK_PLAN_TESTS
    private static var commandOracle: ((String, [String]) throws -> (status: Int32, output: String))?
    #endif

    init(interface: String, nodeAddresses: [String], journal: URL) {
        self.interface = interface
        self.nodeAddresses = nodeAddresses
        self.journalURL = journal
    }

    func apply() throws {
        guard geteuid() == 0 else { throw AppError("Network configuration requires administrator privileges.") }
        guard Self.validTunnel(interface), !nodeAddresses.isEmpty, nodeAddresses.count <= 64 else { throw AppError("Invalid tunnel configuration.") }
        guard storage == nil else { throw AppError("This network transaction is already active.") }
        let store = try RecoveryStorage(logicalURL: journalURL)
        storage = store
        do {
            if let data = try store.read() {
                journal = try Self.decode(data)
                try restoreLocked()
            }
            let next = try snapshot()
            journal = next
            diagnoseSetup("persist")
            // The complete undo record reaches stable storage before any mutation.
            try persist()
            for index in next.routes.indices {
                journal!.routes[index].state = 1
                try persist()
                let route = next.routes[index]
                let category = route.host ? "bypass" : "capture-ipv\(route.family)"
                try Self.add(route) { stage, current in self.diagnoseSetup("\(category)-\(stage)", current: current) }
                journal!.routes[index].state = 2
                try persist()
            }
            for index in next.services.indices {
                diagnoseSetup("dns-set")
                journal!.services[index].state = 1
                try persist()
                try Self.setDNS(Self.tunnelDNS, service: next.services[index].name)
                journal!.services[index].state = 2
                try persist()
            }
            _ = try? Self.execute("/usr/bin/dscacheutil", ["-flushcache"])
            _ = try? Self.execute("/usr/bin/killall", ["-HUP", "mDNSResponder"])
            diagnoseSetup("committed")
        } catch {
            let original = error
            do { try restoreLocked() }
            catch { throw AppError("Network setup failed and rollback is incomplete. Keep the recovery journal and run recovery before reconnecting.") }
            storage = nil
            throw original
        }
    }

    func restore() throws {
        guard geteuid() == 0 else { throw AppError("Network recovery requires administrator privileges.") }
        if storage == nil { storage = try RecoveryStorage(logicalURL: journalURL) }
        if journal == nil, let data = try storage!.read() { journal = try Self.decode(data) }
        try restoreLocked()
        storage = nil
    }

    /// Read-only validation of the committed lease. This never repairs routes
    /// or DNS: an external change ends the session, and restore() preserves
    /// settings which no longer match the transaction's ownership record.
    func verifyActive() throws {
        #if NATIVE_INTEGRATION_TESTS
        verificationFailureClass = "transaction"
        #endif
        guard let journal, storage != nil, journal.interface == interface,
              journal.routes.allSatisfy({ $0.state == 2 }),
              journal.services.allSatisfy({ $0.state == 2 }),
              journal.routes.filter({ !$0.host }).count == 4,
              !journal.services.isEmpty, !nodeAddresses.isEmpty else {
            throw AppError("The VPN network transaction is not fully committed.")
        }
        for route in journal.routes {
            #if NATIVE_INTEGRATION_TESTS
            verificationFailureClass = route.host ? "owned-bypass" : "capture-ipv\(route.family)"
            #endif
            guard let current = try Self.lookup(family: route.family, target: route.target), Self.owns(current, route: route), Self.usable(current) else {
                throw AppError("A VPN capture or server bypass route changed. Reconnect the VPN.")
            }
        }
        // Preexisting physical host routes are deliberately not owned/deleted by
        // us. They still must remain exact physical bypasses for the pinned node.
        for address in nodeAddresses {
            #if NATIVE_INTEGRATION_TESTS
            verificationFailureClass = "pinned-bypass"
            #endif
            guard let family = Self.family(address),
                  let route = try Self.lookup(family: family, target: address),
                  Self.exact(route, destination: address, prefix: family == 4 ? 32 : 128, family: family),
                  Self.validInterface(route.interface), route.interface != interface,
                  !route.interface.hasPrefix("utun"), !route.interface.hasPrefix("tun"),
                  Self.usable(route), Self.stableHostBypass(route) else {
                throw AppError("The pinned VPN server no longer has a physical bypass route.")
            }
        }
        #if NATIVE_INTEGRATION_TESTS
        verificationFailureClass = "dns"
        #endif
        let names = Set(try Self.serviceNames(includeDisabled: true))
        for service in journal.services {
            guard names.contains(service.name), try Self.dns(service.name) == Self.tunnelDNS else {
                throw AppError("VPN DNS ownership changed. Reconnect the VPN.")
            }
        }
        #if NATIVE_INTEGRATION_TESTS
        verificationFailureClass = nil
        #endif
    }

    static func recover(journal: URL) throws {
        let transaction = NetworkPlan(interface: "utun0", nodeAddresses: [], journal: journal)
        try transaction.restore()
    }

    private func persist() throws {
        guard let journal, let storage else { throw AppError("Missing network recovery state.") }
        try storage.write(JSONEncoder().encode(journal))
    }

    private func snapshot() throws -> Journal {
        diagnoseSetup("snapshot-default")
        let original4 = try Self.defaultRoute(family: 4)
        let original6 = try Self.defaultRoute(family: 6)
        guard original4 != nil || original6 != nil else { throw AppError("No usable physical default route is available.") }
        var routes: [Route] = []
        var seen = Set<String>()
        for address in nodeAddresses {
            diagnoseSetup("snapshot-host")
            guard let family = Self.family(address), !address.contains("%") else { throw AppError("VPN server addresses must be numeric unscoped IP addresses.") }
            guard seen.insert(address).inserted else { continue }
            guard !Self.tunnelDNS.contains(where: { Self.equivalent($0, address) }) else { throw AppError("The VPN server conflicts with the tunnel DNS resolver addresses.") }
            let prefix = family == 4 ? 32 : 128
            let existing = try Self.lookup(family: family, target: address)
            diagnoseSetup("snapshot-host-classify", current: existing)
            if let existing, Self.exact(existing, destination: address, prefix: prefix, family: family) {
                guard Self.validInterface(existing.interface), existing.interface != interface,
                      !existing.interface.hasPrefix("utun"), !existing.interface.hasPrefix("tun"), Self.usable(existing) else {
                    throw AppError("A VPN server is already routed through another tunnel.")
                }
                // A successful preflight commonly creates a WASCLONED host
                // cache entry. Darwin may invalidate it when /1 routes change.
                // Only an explicit stable host route can be preserved as a
                // bypass; materialize a journal-owned static route for clones.
                // Apple route.h documents STATIC and WASCLONED separately:
                // https://github.com/apple/darwin-xnu/blob/main/bsd/net/route.h
                if Self.stableHostBypass(existing) { continue }
                guard Self.ephemeralHostClone(existing) else { throw AppError("An existing server host route has unknown ownership.") }
            }
            let original = family == 4 ? original4 : original6
            diagnoseSetup("snapshot-gateway", current: original)
            guard let original, let gateway = original.gateway, Self.family(gateway) == family,
                  Self.validInterface(original.interface), !original.interface.hasPrefix("utun") else {
                throw AppError("A server address has no usable physical gateway. Choose a server address reachable on the current network.")
            }
            routes.append(Route(family: family, destination: address, prefix: prefix, gateway: gateway, interface: original.interface))
        }
        // Always capture both families, including when the physical network has
        // no IPv6 default. A later IPv6 router advertisement cannot bypass the VPN.
        routes += [Route(family: 4, destination: "0.0.0.0", prefix: 1, gateway: nil, interface: interface),
                   Route(family: 4, destination: "128.0.0.0", prefix: 1, gateway: nil, interface: interface),
                   Route(family: 6, destination: "::", prefix: 1, gateway: nil, interface: interface),
                   Route(family: 6, destination: "8000::", prefix: 1, gateway: nil, interface: interface)]
        for route in routes {
            diagnoseSetup("snapshot-conflict")
            if let existing = try Self.lookup(family: route.family, target: route.target),
               Self.exact(existing, destination: route.destination, prefix: route.prefix, family: route.family) {
                diagnoseSetup("snapshot-conflict", current: existing)
                if route.host, Self.replaceableClone(existing, route: route) { continue }
                throw AppError("A required route already exists. Disconnect other VPNs before connecting.")
            }
        }
        var services: [Service] = []
        diagnoseSetup("snapshot-dns")
        for name in try Self.serviceNames() {
            let info = try Self.fields(Self.execute("/usr/sbin/networksetup", ["-getinfo", name]))
            let active4 = info["IP address"].flatMap(Self.family) == 4
            let active6 = info["IPv6 IP address"].flatMap(Self.family) == 6
            if active4 || active6 { services.append(Service(name: name, dns: try Self.dns(name))) }
        }
        guard !services.isEmpty else { throw AppError("No active network service is available for DNS configuration.") }
        return Journal(interface: interface, routes: routes, services: services)
    }

    private func restoreLocked() throws {
        guard var value = journal else { return }
        var failed = false
        let services: Set<String>
        do { services = Set(try Self.serviceNames(includeDisabled: true)) }
        catch { services = []; failed = true }
        // Restore DNS before removing split routes so public DNS cannot briefly
        // escape over the physical connection during normal disconnect.
        for index in value.services.indices where value.services[index].state == 1 || value.services[index].state == 2 {
            do {
                let service = value.services[index]
                if services.contains(service.name) {
                    let current = try Self.dns(service.name)
                    // Preserve an explicit configuration change made outside the
                    // app while connected. Recover only DNS settings we installed.
                    if current == Self.tunnelDNS { try Self.setDNS(service.dns, service: service.name) }
                } else if failed { continue }
                value.services[index].state = 3
                journal = value
                try persist()
            } catch { failed = true }
        }
        for index in value.routes.indices.reversed() where value.routes[index].state == 1 || value.routes[index].state == 2 {
            do {
                let route = value.routes[index]
                var current = try Self.lookup(family: route.family, target: route.target)
                // A scoped host cache can hide an unscoped owned bypass after
                // an interrupted add. Expose the unscoped entry before deciding
                // it is absent. Unknown scoped host entries retain the journal.
                if route.host, let cached = current, cached.flags.contains("IFSCOPE"),
                   Self.exact(cached, destination: route.destination, prefix: route.prefix, family: route.family) {
                    guard Self.replaceableClone(cached, route: route) else { throw AppError("A scoped server route prevents safe network recovery.") }
                    try Self.removeClone(cached, route: route)
                    current = try Self.lookup(family: route.family, target: route.target)
                    if let current, current.flags.contains("IFSCOPE"), Self.exact(current, destination: route.destination, prefix: route.prefix, family: route.family) {
                        throw AppError("The unscoped server bypass could not be inspected safely.")
                    }
                }
                if let current, Self.owns(current, route: route) {
                    try Self.delete(route)
                }
                value.routes[index].state = 3
                journal = value
                try persist()
            } catch { failed = true }
        }
        journal = value
        if failed { throw AppError("Some network settings could not be restored. Recovery state was retained.") }
        try storage?.remove()
        journal = nil
        _ = try? Self.execute("/usr/bin/dscacheutil", ["-flushcache"])
        _ = try? Self.execute("/usr/bin/killall", ["-HUP", "mDNSResponder"])
    }

    private static func add(_ route: Route, observe: (String, RouteInfo?) -> Void) throws {
        // RTF_PROTO2 identifies routes created by this transaction, including the
        // narrow crash interval between a successful add and its journal commit.
        var arguments = ["-n", "add", route.family == 4 ? "-inet" : "-inet6", route.host ? "-host" : "-net", route.target, "-static", "-proto2"]
        if let gateway = route.gateway { arguments += [gateway, "-ifp", route.interface] }
        else { arguments += ["-interface", route.interface] }
        observe("add-command", nil)
        do { _ = try execute("/sbin/route", arguments) }
        catch {
            // apply() persisted state=1 before entering this method. If an
            // ephemeral cache route prevents adding the durable bypass, remove
            // only the exact verified physical clone and retry once. A deleted
            // cache entry is regenerated from the untouched physical default.
            guard route.host else { throw error }
            let collision = try lookup(family: route.family, target: route.target)
            observe("clone-check", collision)
            guard let current = collision, replaceableClone(current, route: route) else { throw error }
            observe("clone-remove", current)
            try removeClone(current, route: route)
            observe("clone-retry", nil)
            _ = try execute("/sbin/route", arguments)
        }
        var current = try lookup(family: route.family, target: route.target)
        observe("readback", current)
        // Scoped preflight cache entries can coexist with a successful unscoped
        // static add. A GET may still select that old scoped clone. Remove only
        // the verified ephemeral scoped entry, then demand the owned readback.
        if let cached = current, !owns(cached, route: route), cached.flags.contains("IFSCOPE"), replaceableClone(cached, route: route) {
            observe("clone-remove", cached)
            try removeClone(cached, route: route)
            current = try lookup(family: route.family, target: route.target)
            observe("readback", current)
        }
        guard let current, owns(current, route: route) else { throw AppError("The operating system did not confirm the requested owned route.") }
    }
    private static func removeClone(_ current: RouteInfo, route: Route) throws {
        guard replaceableClone(current, route: route) else { throw AppError("The server cache route changed before replacement.") }
        var arguments = ["-n", "delete", route.family == 4 ? "-inet" : "-inet6", "-host", route.target]
        if current.flags.contains("IFSCOPE") { arguments += ["-ifscope", current.interface] }
        if let gateway = route.gateway { arguments += [gateway, "-ifp", route.interface] }
        _ = try execute("/sbin/route", arguments)
    }
    private func diagnoseSetup(_ stage: String, current: RouteInfo? = nil) {
        #if NATIVE_INTEGRATION_TESTS
        setupStage = stage
        setupRouteFlags = []; setupInterfaceClass = "missing"
        if let current {
            let allowed = Set(["UP", "GATEWAY", "HOST", "DONE", "STATIC", "WASCLONED", "CLONING", "PRCLONING", "IFSCOPE", "IFREF", "PROTO1", "PROTO2", "PROTO3", "DYNAMIC", "MODIFIED", "REJECT", "BLACKHOLE", "LOCAL", "LLINFO", "ROUTER", "GLOBAL"])
            setupRouteFlags = current.flags.intersection(allowed).sorted()
            setupInterfaceClass = current.interface.hasPrefix("utun") || current.interface.hasPrefix("tun") ? "tunnel" : (current.interface.hasPrefix("lo") ? "loopback" : "physical")
        }
        #endif
    }
    private static func delete(_ route: Route) throws {
        var arguments = ["-n", "delete", route.family == 4 ? "-inet" : "-inet6", route.host ? "-host" : "-net", route.target]
        if let gateway = route.gateway { arguments += [gateway, "-ifp", route.interface] }
        else { arguments += ["-interface", route.interface] }
        _ = try execute("/sbin/route", arguments)
    }
    private static func usable(_ route: RouteInfo) -> Bool {
        route.flags.contains("UP") && !route.flags.contains("REJECT") && !route.flags.contains("BLACKHOLE")
    }
    private static func stableHostBypass(_ route: RouteInfo) -> Bool {
        route.flags.contains("HOST") && route.flags.contains("STATIC") &&
        route.flags.isDisjoint(with: ["WASCLONED", "DYNAMIC", "MODIFIED", "IFSCOPE"])
    }
    private static func ephemeralHostClone(_ route: RouteInfo) -> Bool {
        route.flags.contains("HOST") && route.flags.contains("WASCLONED") &&
        route.flags.isDisjoint(with: ["STATIC", "PROTO1", "PROTO2", "PROTO3", "DYNAMIC", "MODIFIED", "REJECT", "BLACKHOLE"])
    }
    private static func replaceableClone(_ current: RouteInfo, route: Route) -> Bool {
        route.host && ephemeralHostClone(current) && usable(current) &&
        current.interface == route.interface && equivalent(current.gateway ?? "", route.gateway ?? "") &&
        exact(current, destination: route.destination, prefix: route.prefix, family: route.family)
    }
    private static func owns(_ current: RouteInfo, route: Route) -> Bool {
        guard current.flags.contains("PROTO2"), current.flags.contains("STATIC"), !current.flags.contains("WASCLONED"), current.interface == route.interface,
              exact(current, destination: route.destination, prefix: route.prefix, family: route.family) else { return false }
        if let gateway = route.gateway { return equivalent(current.gateway ?? "", gateway) }
        return !current.flags.contains("GATEWAY")
    }
    private static func exact(_ current: RouteInfo, destination: String, prefix: Int, family: Int) -> Bool {
        let raw = current.fields["destination"] ?? ""
        let pieces = raw.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        let printed = pieces.first ?? ""
        let address = printed == "default" ? (family == 4 ? "0.0.0.0" : "::") : (family == 4 && printed == "0" ? "0.0.0.0" : printed)
        guard equivalent(address, destination) else { return false }
        if pieces.count == 2 { return Int(pieces[1]) == prefix }
        if prefix == (family == 4 ? 32 : 128) { return current.flags.contains("HOST") }
        let mask = current.fields["mask"] ?? current.fields["netmask"] ?? ""
        return prefix == 1 && equivalent(mask, family == 4 ? "128.0.0.0" : "8000::")
    }
    #if NATIVE_INTEGRATION_TESTS || NETWORK_PLAN_TESTS
    static func isExactSplitSnapshot(_ values: [String: String], family: Int, upper: Bool) -> Bool {
        let destination = family == 4 ? (upper ? "128.0.0.0" : "0.0.0.0") : (upper ? "8000::" : "::")
        return exact(RouteInfo(fields: values), destination: destination, prefix: 1, family: family)
    }
    #endif
    private static func defaultRoute(family: Int) throws -> RouteInfo? {
        guard let route = try lookup(family: family, target: "default") else { return nil }
        guard validInterface(route.interface), !route.interface.hasPrefix("utun") else {
            throw AppError("The default route belongs to another tunnel. Disconnect it first.")
        }
        return route
    }
    private static func lookup(family: Int, target: String) throws -> RouteInfo? {
        let result = try executeResult("/sbin/route", ["-n", "get", family == 4 ? "-inet" : "-inet6", target])
        return try parseLookup(status: result.status, output: result.output)
    }
    /// Darwin route(8) can report a missing IPv6 route while returning exit 0.
    /// The native smoke snapshot shares this exact diagnostic classification.
    static func isMissingRouteDiagnostic(_ output: String) -> Bool {
        let text = output.lowercased()
        return ["not in table", "not found", "route has not been found", "network is unreachable", "no route to host"]
            .contains(where: text.contains)
    }
    private static func parseLookup(status: Int32, output: String) throws -> RouteInfo? {
        if isMissingRouteDiagnostic(output) { return nil }
        guard status == 0 else { throw AppError("Could not inspect the existing routing table.") }
        let value = RouteInfo(fields: fields(output))
        guard validInterface(value.interface), value.fields["destination"]?.isEmpty == false,
              value.fields["flags"]?.isEmpty == false else {
            throw AppError("The routing utility returned an unknown route response.")
        }
        return value
    }
    private static func fields(_ text: String) -> [String: String] {
        var result: [String: String] = [:]
        for line in text.components(separatedBy: .newlines) {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            result[key] = value
        }
        return result
    }
    private static func serviceNames(includeDisabled: Bool = false) throws -> [String] {
        let text = try execute("/usr/sbin/networksetup", ["-listallnetworkservices"])
        let lines = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
        var names: [String] = []
        for line in lines {
            if line.hasPrefix("An asterisk") { continue }
            if line.hasPrefix("*") {
                if includeDisabled { names.append(String(line.dropFirst())) }
            } else { names.append(line) }
        }
        guard names.count <= 128, names.allSatisfy(validService) else { throw AppError("Unexpected network service list.") }
        return names
    }
    private static func dns(_ service: String) throws -> [String] {
        let text = try execute("/usr/sbin/networksetup", ["-getdnsservers", service]).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("There aren't any DNS Servers set on ") { return [] }
        let values = text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !values.isEmpty, values.count <= 32, values.allSatisfy({ family($0) != nil }) else { throw AppError("Unexpected DNS configuration.") }
        return values
    }
    private static func setDNS(_ addresses: [String], service: String) throws {
        _ = try execute("/usr/sbin/networksetup", ["-setdnsservers", service] + (addresses.isEmpty ? ["Empty"] : addresses))
        guard try dns(service) == addresses else { throw AppError("The operating system did not confirm the requested DNS configuration.") }
    }
    private static func validTunnel(_ value: String) -> Bool {
        value.hasPrefix("utun") && value.count > 4 && value.dropFirst(4).utf8.allSatisfy { $0 >= 48 && $0 <= 57 } && value.utf8.count < 16
    }
    private static func validInterface(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count < 16 && value.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) }
    }
    private static func validService(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 256 && !value.contains("\0") && !value.contains("\n") && !value.contains("\r")
    }
    private static func family(_ address: String) -> Int? {
        let parts = address.split(separator: "%", omittingEmptySubsequences: false)
        guard parts.count <= 2, let base = parts.first else { return nil }
        if parts.count == 2 && !validInterface(String(parts[1])) { return nil }
        var four = in_addr(), six = in6_addr()
        if parts.count == 1 && String(base).withCString({ inet_pton(AF_INET, $0, &four) }) == 1 { return 4 }
        if String(base).withCString({ inet_pton(AF_INET6, $0, &six) }) == 1 { return 6 }
        return nil
    }
    private static func equivalent(_ a: String, _ b: String) -> Bool {
        guard let f = family(a), f == family(b) else { return false }
        let left = String(a.split(separator: "%")[0]), right = String(b.split(separator: "%")[0])
        var x = [UInt8](repeating: 0, count: 16), y = x
        let af = f == 4 ? AF_INET : AF_INET6
        let first = x.withUnsafeMutableBytes { out in left.withCString { inet_pton(af, $0, out.baseAddress) } }
        let second = y.withUnsafeMutableBytes { out in right.withCString { inet_pton(af, $0, out.baseAddress) } }
        return first == 1 && second == 1 && x == y
    }
    private static func decode(_ data: Data) throws -> Journal {
        let value = try JSONDecoder().decode(Journal.self, from: data)
        guard value.version == 1, validTunnel(value.interface), value.routes.count <= 68, value.services.count <= 128 else { throw AppError("Invalid network recovery journal.") }
        for route in value.routes {
            let allowed = route.host || (route.prefix == 1 && ((route.family == 4 && ["0.0.0.0", "128.0.0.0"].contains(route.destination)) || (route.family == 6 && ["::", "8000::"].contains(route.destination))))
            guard allowed, family(route.destination) == route.family, validInterface(route.interface), (0...3).contains(route.state),
                  route.gateway == nil || family(route.gateway!) == route.family,
                  (route.host ? route.gateway != nil : route.interface == value.interface) else { throw AppError("Invalid route recovery record.") }
        }
        for service in value.services {
            guard validService(service.name), service.dns.count <= 32, service.dns.allSatisfy({ family($0) != nil }), (0...3).contains(service.state) else { throw AppError("Invalid DNS recovery record.") }
        }
        return value
    }

    #if NETWORK_PLAN_TESTS
    /// Exercises the same route parser and ownership decision used by active
    /// verification and cleanup, without executing any system command.
    static func runReadOnlyVerificationTests() throws {
        func expect(_ condition: Bool) throws {
            if !condition { throw AppError("Network route ownership parser test failed.") }
        }
        let split4 = Route(family: 4, destination: "0.0.0.0", prefix: 1, gateway: nil, interface: "utun7")
        let good4 = RouteInfo(fields: fields("destination: 0.0.0.0\nmask: 128.0.0.0\ninterface: utun7\nflags: <UP,DONE,STATIC,PROTO2>\n"))
        try expect(owns(good4, route: split4) && usable(good4))
        for flags in ["<UP,STATIC,PROTO2,REJECT>", "<UP,STATIC,PROTO2,BLACKHOLE>", "<STATIC,PROTO2>"] {
            try expect(!usable(RouteInfo(fields: good4.fields.merging(["flags": flags]) { _, new in new })))
        }
        for patch in [["flags": "<UP,DONE,STATIC>"], ["interface": "en0"], ["mask": "0.0.0.0"], ["flags": "<UP,GATEWAY,STATIC,PROTO2>"]] {
            try expect(!owns(RouteInfo(fields: good4.fields.merging(patch) { _, new in new }), route: split4))
        }
        let split6 = Route(family: 6, destination: "::", prefix: 1, gateway: nil, interface: "utun7")
        let good6 = RouteInfo(fields: fields("destination: default\nmask: 8000::\ninterface: utun7\nflags: <UP,DONE,STATIC,PROTO2>\n"))
        try expect(owns(good6, route: split6))
        let cidr6 = RouteInfo(fields: good6.fields.merging(["destination": "::/1", "mask": ""]) { _, new in new })
        try expect(owns(cidr6, route: split6))
        try expect(isExactSplitSnapshot(good4.fields, family: 4, upper: false))
        try expect(isExactSplitSnapshot(good6.fields, family: 6, upper: false))
        try expect(!isExactSplitSnapshot(fields("destination: default\nmask: default\ninterface: en0\nflags: <UP,GATEWAY,DONE>\n"), family: 4, upper: false))
        try expect(!isExactSplitSnapshot(fields("destination: default\nmask: ::\ninterface: en0\nflags: <UP,GATEWAY,DONE>\n"), family: 6, upper: false))
        let host = Route(family: 4, destination: "203.0.113.9", prefix: 32, gateway: "192.0.2.1", interface: "en0")
        let physical = RouteInfo(fields: fields("destination: 203.0.113.9\ngateway: 192.0.2.1\ninterface: en0\nflags: <UP,GATEWAY,HOST,DONE,STATIC,PROTO2>\n"))
        try expect(owns(physical, route: host))
        try expect(stableHostBypass(physical))
        let manual = RouteInfo(fields: physical.fields.merging(["flags": "<UP,GATEWAY,HOST,DONE,STATIC>"]) { _, new in new })
        try expect(stableHostBypass(manual) && !owns(manual, route: host))
        let clone = RouteInfo(fields: physical.fields.merging(["flags": "<UP,GATEWAY,HOST,DONE,WASCLONED,IFREF>"]) { _, new in new })
        try expect(ephemeralHostClone(clone) && replaceableClone(clone, route: host) && !stableHostBypass(clone) && !owns(clone, route: host))
        let scopedClone = RouteInfo(fields: clone.fields.merging(["flags": "<UP,GATEWAY,HOST,DONE,WASCLONED,IFSCOPE,IFREF>"]) { _, new in new })
        try expect(replaceableClone(scopedClone, route: host))
        for flags in ["<UP,GATEWAY,HOST,DONE>", "<UP,GATEWAY,HOST,DONE,STATIC,WASCLONED>",
                      "<UP,GATEWAY,HOST,DONE,WASCLONED,PROTO2>", "<UP,GATEWAY,HOST,DONE,WASCLONED,DYNAMIC>"] {
            let unknown = RouteInfo(fields: clone.fields.merging(["flags": flags]) { _, new in new })
            try expect(!replaceableClone(unknown, route: host))
        }
        for patch in [["interface": "utun7"], ["gateway": "192.0.2.2"], ["destination": "203.0.113.10"]] {
            try expect(!replaceableClone(RouteInfo(fields: clone.fields.merging(patch) { _, new in new }), route: host))
        }
        let scopedStatic = RouteInfo(fields: physical.fields.merging(["flags": "<UP,GATEWAY,HOST,DONE,STATIC,IFSCOPE>"]) { _, new in new })
        try expect(!stableHostBypass(scopedStatic) && !replaceableClone(scopedStatic, route: host))
        func rendered(_ route: RouteInfo) -> String { route.fields.keys.sorted().map { "\($0): \(route.fields[$0]!)" }.joined(separator: "\n") }
        func exerciseAdd(_ responses: [(Int32, String)], shouldFail: Bool) throws -> [[String]] {
            var remaining = responses
            var commands = [[String]]()
            commandOracle = { executable, arguments in
                guard executable == "/sbin/route", !remaining.isEmpty else { throw AppError("Unexpected route command in parser regression.") }
                commands.append(arguments)
                return remaining.removeFirst()
            }
            defer { commandOracle = nil }
            var failed = false
            do { try add(host) { _, _ in } } catch { failed = true }
            try expect(failed == shouldFail && remaining.isEmpty)
            return commands
        }
        // A successful unscoped add does not guarantee GET sees it: Darwin
        // prefers an equal-length primary-interface scoped host cache entry.
        let scopedText = rendered(scopedClone), ownedText = rendered(physical)
        let successful = try exerciseAdd([(0, ""), (0, scopedText), (0, ""), (0, ownedText)], shouldFail: false)
        try expect(successful.map { $0[1] } == ["add", "get", "delete", "get"])
        try expect(successful[2].contains("-ifscope") && successful[2].contains("en0"))
        let collision = try exerciseAdd([(1, "route: File exists"), (0, scopedText), (0, ""), (0, ""), (0, ownedText)], shouldFail: false)
        try expect(collision.map { $0[1] } == ["add", "get", "delete", "add", "get"])
        let manualCollision = try exerciseAdd([(0, ""), (0, rendered(scopedStatic))], shouldFail: true)
        try expect(manualCollision.map { $0[1] } == ["add", "get"])
        let stillHidden = try exerciseAdd([(0, ""), (0, scopedText), (0, ""), (0, scopedText)], shouldFail: true)
        try expect(stillHidden.filter { $0[1] == "delete" }.count == 1)
        try expect(!owns(RouteInfo(fields: physical.fields.merging(["gateway": "192.0.2.2"]) { _, new in new }), route: host))
        try expect(!owns(RouteInfo(fields: physical.fields.merging(["flags": "<UP,GATEWAY,DONE,STATIC,PROTO2>"]) { _, new in new }), route: host))
        // Missing IPv6 defaults are normal on IPv4-only networks. Darwin does
        // not consistently communicate absence through its process exit code.
        for status: Int32 in [0, 1] {
            for diagnostic in ["route: route has not been found\n", "route: writing to routing socket: not in table\n",
                               "route: Network is unreachable\n", "route: No route to host\n"] {
                try expect(try parseLookup(status: status, output: diagnostic) == nil)
            }
        }
        let parsed = try parseLookup(status: 0, output: "destination: default\ngateway: 192.0.2.1\ninterface: en0\nflags: <UP,GATEWAY,DONE,STATIC>\n")
        try expect(parsed?.interface == "en0" && parsed?.gateway == "192.0.2.1")
        for (status, output): (Int32, String) in [(0, ""), (0, "route: permission denied\n"),
                                                  (0, "route: unexpected response\n"),
                                                  (1, "route: permission denied\n")] {
            var accepted = false
            do { _ = try parseLookup(status: status, output: output); accepted = true } catch { }
            try expect(!accepted)
        }
        print("network route parser tests passed without system mutation")
    }
    #endif

    private static func execute(_ executable: String, _ arguments: [String]) throws -> String {
        let result = try executeResult(executable, arguments)
        guard result.status == 0 else { throw AppError("A network configuration command failed (exit \(result.status)).") }
        return result.output
    }
    private static func executeResult(_ executable: String, _ arguments: [String]) throws -> (status: Int32, output: String) {
        #if NETWORK_PLAN_TESTS
        if let commandOracle { return try commandOracle(executable, arguments) }
        #endif
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C", "LC_ALL": "C"]
        process.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let timeout = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timeout.schedule(deadline: .now() + 15)
        timeout.setEventHandler { if process.isRunning { process.terminate() } }
        timeout.resume()
        defer { timeout.cancel() }
        var data = Data()
        while true {
            let chunk = pipe.fileHandleForReading.readData(ofLength: 4096)
            if chunk.isEmpty { break }
            guard data.count + chunk.count <= 1024 * 1024 else {
                process.terminate()
                process.waitUntilExit()
                throw AppError("A network utility returned excessive output.")
            }
            data.append(chunk)
        }
        process.waitUntilExit()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }
}

/// The public journal URL identifies a logical file in user support. Actual
/// storage is in a root-owned 0700 `.root-network` directory beneath that parent.
/// Paths are traversed with O_NOFOLLOW; contents and renames use directory fds.
private final class RecoveryStorage {
    private let directory: Int32
    private let lock: Int32
    private let name: String
    init(logicalURL: URL) throws {
        guard logicalURL.isFileURL, logicalURL.path.hasPrefix("/"),
              !logicalURL.lastPathComponent.isEmpty, logicalURL.lastPathComponent.utf8.count < 128,
              logicalURL.lastPathComponent != ".", logicalURL.lastPathComponent != "..",
              !logicalURL.lastPathComponent.contains("\0"), logicalURL.lastPathComponent != "network.lock" else { throw AppError("Invalid network journal location.") }
        name = logicalURL.lastPathComponent
        let parent = logicalURL.deletingLastPathComponent()
        var current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard current >= 0 else { throw AppError("Cannot open the recovery directory.") }
        do {
            for component in parent.pathComponents where component != "/" {
                guard component != ".", component != "..", !component.contains("\0") else { throw AppError("Invalid recovery path.") }
                var next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                if next < 0 && errno == ENOENT {
                    guard mkdirat(current, component, 0o700) == 0 else { throw AppError("Cannot create the recovery directory.") }
                    next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                }
                guard next >= 0 else { throw AppError("The recovery path contains an inaccessible directory or symbolic link.") }
                close(current); current = next
            }
            if mkdirat(current, ".root-network", 0o700) != 0 && errno != EEXIST { throw AppError("Cannot create private recovery storage.") }
            guard fsync(current) == 0 else { throw AppError("Cannot sync the private recovery directory.") }
            let secured = openat(current, ".root-network", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard secured >= 0 else { throw AppError("Cannot open private recovery storage.") }
            close(current); current = secured
            var metadata = stat()
            guard fstat(current, &metadata) == 0, metadata.st_uid == 0, metadata.st_mode & 0o777 == 0o700 else { throw AppError("Recovery storage must be owned by root with mode 0700.") }
            let lockFD = openat(current, "network.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
            guard lockFD >= 0 else { throw AppError("Cannot open the network configuration lock.") }
            guard fstat(lockFD, &metadata) == 0, Self.privateRegular(metadata), flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
                close(lockFD); throw AppError("Another VPN process is active or recovery storage is unsafe.")
            }
            directory = current
            lock = lockFD
        } catch { close(current); throw error }
    }
    deinit { close(lock); close(directory) }
    private static func privateRegular(_ metadata: stat) -> Bool {
        metadata.st_uid == 0 && metadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) && metadata.st_mode & 0o777 == 0o600 && metadata.st_nlink == 1
    }
    func read() throws -> Data? {
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else { throw AppError("Cannot open the network recovery journal.") }
        defer { close(fd) }
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, Self.privateRegular(metadata), metadata.st_size >= 0, metadata.st_size <= 1024 * 1024 else { throw AppError("Unsafe network recovery journal.") }
        var bytes = [UInt8](repeating: 0, count: Int(metadata.st_size))
        var offset = 0
        while offset < bytes.count {
            let count = bytes.withUnsafeMutableBytes { raw in systemRead(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset) }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw AppError("Cannot read the network recovery journal.") }
            offset += count
        }
        return Data(bytes)
    }
    func write(_ data: Data) throws {
        let temporary = ".\(name).\(UUID().uuidString).tmp"
        let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard fd >= 0 else { throw AppError("Cannot create a network recovery checkpoint.") }
        defer { close(fd); _ = unlinkat(directory, temporary, 0) }
        var offset = 0
        while offset < data.count {
            let count = data.withUnsafeBytes { bytes in systemWrite(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset) }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw AppError("Cannot write a network recovery checkpoint.") }
            offset += count
        }
        guard fsync(fd) == 0, renameat(directory, temporary, directory, name) == 0, fsync(directory) == 0 else { throw AppError("Cannot commit the network recovery checkpoint.") }
    }
    func remove() throws {
        guard unlinkat(directory, name, 0) == 0 || errno == ENOENT else { throw AppError("Cannot remove the restored network journal.") }
        guard fsync(directory) == 0 else { throw AppError("Cannot sync the restored network journal directory.") }
    }
}
#if canImport(Darwin)
private func systemRead(_ fd: Int32, _ p: UnsafeMutableRawPointer, _ n: Int) -> Int { Darwin.read(fd, p, n) }
private func systemWrite(_ fd: Int32, _ p: UnsafeRawPointer, _ n: Int) -> Int { Darwin.write(fd, p, n) }
#else
private func systemRead(_ fd: Int32, _ p: UnsafeMutableRawPointer, _ n: Int) -> Int { Glibc.read(fd, p, n) }
private func systemWrite(_ fd: Int32, _ p: UnsafeRawPointer, _ n: Int) -> Int { Glibc.write(fd, p, n) }
#endif
