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
    private static let tunnelDNS = ["1.1.1.1", "8.8.8.8"]

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
            // The complete undo record reaches stable storage before any mutation.
            try persist()
            for index in next.routes.indices {
                journal!.routes[index].state = 1
                try persist()
                try Self.add(next.routes[index])
                journal!.routes[index].state = 2
                try persist()
            }
            for index in next.services.indices {
                journal!.services[index].state = 1
                try persist()
                try Self.setDNS(Self.tunnelDNS, service: next.services[index].name)
                journal!.services[index].state = 2
                try persist()
            }
            _ = try? Self.execute("/usr/bin/dscacheutil", ["-flushcache"])
            _ = try? Self.execute("/usr/bin/killall", ["-HUP", "mDNSResponder"])
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

    static func recover(journal: URL) throws {
        let transaction = NetworkPlan(interface: "utun0", nodeAddresses: [], journal: journal)
        try transaction.restore()
    }

    private func persist() throws {
        guard let journal, let storage else { throw AppError("Missing network recovery state.") }
        try storage.write(JSONEncoder().encode(journal))
    }

    private func snapshot() throws -> Journal {
        let original4 = try Self.defaultRoute(family: 4)
        let original6 = try Self.defaultRoute(family: 6)
        guard original4 != nil || original6 != nil else { throw AppError("No usable physical default route is available.") }
        var routes: [Route] = []
        var seen = Set<String>()
        for address in nodeAddresses {
            guard let family = Self.family(address), !address.contains("%") else { throw AppError("VPN server addresses must be numeric unscoped IP addresses.") }
            guard seen.insert(address).inserted else { continue }
            guard !Self.tunnelDNS.contains(where: { Self.equivalent($0, address) }) else { throw AppError("The VPN server conflicts with the tunnel DNS resolver addresses.") }
            let prefix = family == 4 ? 32 : 128
            let existing = try Self.lookup(family: family, target: address)
            if let existing, Self.exact(existing, destination: address, prefix: prefix, family: family) {
                // A more-specific preexisting physical host route already bypasses
                // our /1 routes. Preserve it rather than claiming ownership.
                guard existing.interface != interface && !existing.interface.hasPrefix("utun") else {
                    throw AppError("A VPN server is already routed through another tunnel.")
                }
                continue
            }
            let original = family == 4 ? original4 : original6
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
            if let existing = try Self.lookup(family: route.family, target: route.target),
               Self.exact(existing, destination: route.destination, prefix: route.prefix, family: route.family) {
                throw AppError("A required route already exists. Disconnect other VPNs before connecting.")
            }
        }
        var services: [Service] = []
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
                if let current = try Self.lookup(family: route.family, target: route.target), Self.owns(current, route: route) {
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

    private static func add(_ route: Route) throws {
        // RTF_PROTO2 identifies routes created by this transaction, including the
        // narrow crash interval between a successful add and its journal commit.
        var arguments = ["-n", "add", route.family == 4 ? "-inet" : "-inet6", route.host ? "-host" : "-net", route.target, "-proto2"]
        if let gateway = route.gateway { arguments += [gateway, "-ifp", route.interface] }
        else { arguments += ["-interface", route.interface] }
        _ = try execute("/sbin/route", arguments)
        guard let current = try lookup(family: route.family, target: route.target), owns(current, route: route) else { throw AppError("The operating system did not confirm the requested owned route.") }
    }
    private static func delete(_ route: Route) throws {
        var arguments = ["-n", "delete", route.family == 4 ? "-inet" : "-inet6", route.host ? "-host" : "-net", route.target]
        if let gateway = route.gateway { arguments += [gateway, "-ifp", route.interface] }
        else { arguments += ["-interface", route.interface] }
        _ = try execute("/sbin/route", arguments)
    }
    private static func owns(_ current: RouteInfo, route: Route) -> Bool {
        guard current.flags.contains("PROTO2"), current.interface == route.interface,
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
    private static func defaultRoute(family: Int) throws -> RouteInfo? {
        guard let route = try lookup(family: family, target: "default") else { return nil }
        guard validInterface(route.interface), !route.interface.hasPrefix("utun") else {
            throw AppError("The default route belongs to another tunnel. Disconnect it first.")
        }
        return route
    }
    private static func lookup(family: Int, target: String) throws -> RouteInfo? {
        let result = try executeResult("/sbin/route", ["-n", "get", family == 4 ? "-inet" : "-inet6", target])
        if result.status != 0 {
            // Missing routes are expected on networks without one address family.
            if result.output.contains("not in table") || result.output.contains("not found") || result.output.contains("Network is unreachable") || result.output.contains("No route to host") { return nil }
            throw AppError("Could not inspect the existing routing table.")
        }
        return RouteInfo(fields: fields(result.output))
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

    private static func execute(_ executable: String, _ arguments: [String]) throws -> String {
        let result = try executeResult(executable, arguments)
        guard result.status == 0 else { throw AppError("A network configuration command failed (exit \(result.status)).") }
        return result.output
    }
    private static func executeResult(_ executable: String, _ arguments: [String]) throws -> (status: Int32, output: String) {
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
