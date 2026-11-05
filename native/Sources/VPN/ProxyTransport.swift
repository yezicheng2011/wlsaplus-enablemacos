#if canImport(Network)   // drives the Network.framework transport stack
import Foundation
import Dispatch

/// One TCP stream or one fixed-destination UDP association. Callbacks run on `queue`.
/// For UDP, every send/onData invocation is exactly one datagram, including empty datagrams.
/// `onReady` means the transport is connected and the request header has been queued;
/// it does not assert that the remote proxy accepted credentials or reached the destination.
/// VMess standard framing rejects empty UDP datagrams because they encode stream termination.
/// Trojan UDP rides inside its proxy stream, so it dials TCP like every non-Shadowsocks protocol.
/// The connection drives one ProxySession over the transport stack its TransportPlan describes.
final class ProxyConnection {
    var onReady: (() -> Void)?
    var onData: ((Data) -> Void)?
    var onError: ((Error) -> Void)?
    var onClose: (() -> Void)?

    private let node: ProxyNode
    private let host: String
    private let port: UInt16
    private let datagram: Bool
    private let queue: DispatchQueue
    private var transport: ByteTransport?
    private var session: ProxySession?
    private var plan: TransportPlan?
    private var started = false
    private var ready = false
    private var closed = false
    private var writeEnded = false
    private var finishPending = false
    private var pending = [Data]()
    private var pendingBytes = 0
    private var timeout: DispatchWorkItem?

    init(node: ProxyNode, destinationHost: String, destinationPort: UInt16,
         udp: Bool, queue: DispatchQueue) {
        self.node = node; host = destinationHost; port = destinationPort
        datagram = udp; self.queue = queue
    }

    func start() { queue.async { self.startOnQueue() } }
    func send(_ data: Data) { queue.async { self.sendOnQueue(data) } }
    func close() { queue.async { self.closeOnQueue() } }
    /// Preserve incoming responses after the local TCP peer sends FIN.
    func finishWriting() { queue.async { self.finishWritingOnQueue() } }
    func setReadEnabled(_ enabled: Bool) { queue.async { self.transport?.setReadEnabled(enabled) } }

    private func startOnQueue() {
        guard !started, !closed else { return }
        started = true
        do {
            try node.validate()
            guard port != 0 else { throw ProxyError.configuration("Missing destination port") }
            if datagram && node.udp != true { throw ProxyError.unsupported("UDP is disabled for this server") }
            let session = try Self.makeSession(node: node, host: host, port: port, udp: datagram)
            let plan = try TransportPlan.make(for: node, datagramSocket: datagram && session.usesDatagramSocket)
            let channel = try TransportStack.make(node: node, plan: plan, queue: queue)
            self.session = session; self.plan = plan; transport = channel
            channel.onReady = { [weak self] in self?.transportReady() }
            channel.onData = { [weak self] in self?.receive($0) }
            channel.onError = { [weak self] in self?.fail($0) }
            channel.onClose = { [weak self] in self?.transportClosed() }
            let deadline = DispatchWorkItem { [weak self] in self?.fail(ProxyError.timeout) }
            timeout = deadline
            // Outer budget covers IPv4-then-IPv6 failover for SS/WS endpoints.
            queue.asyncAfter(deadline: .now() + 28, execute: deadline)
            channel.start()
        } catch { fail(error) }
    }

    /// Protocol layer for a node type that `ProxyNode.validate()` accepted.
    static func makeSession(node: ProxyNode, host: String, port: UInt16, udp: Bool) throws -> ProxySession {
        switch node.type.lowercased() {
        case "ss", "shadowsocks":
            guard let password = node.password, !password.isEmpty else {
                throw ProxyError.configuration("Shadowsocks requires a non-empty password")
            }
            guard let method = ShadowsocksCipher(name: node.cipher) else {
                throw ProxyError.unsupported("Unsupported Shadowsocks cipher")
            }
            return try ShadowsocksSession(password: password, destinationHost: host,
                                          destinationPort: port, udp: udp, cipher: method)
        case "vless":
            return try VLESSSession(uuid: node.uuid ?? "", destinationHost: host,
                                    destinationPort: port, udp: udp)
        case "trojan":
            return try TrojanSession(password: node.password ?? "", destinationHost: host,
                                     destinationPort: port, udp: udp)
        case "vmess":
            return try VMessSession(uuid: node.uuid ?? "", alterId: node.alterId ?? 0,
                                    destinationHost: host, destinationPort: port, udp: udp,
                                    security: VMessSecurity(name: node.cipher) ?? .aes128gcm)
        default: throw ProxyError.unsupported("Unsupported proxy protocol")
        }
    }

    private func transportReady() {
        guard !closed else { return }
        do {
            ready = true
            timeout?.cancel(); timeout = nil
            let waiting = pending; pending.removeAll(); pendingBytes = 0
            if streamWrites {
                // Header and early data leave together: one TLS record / WebSocket frame
                // instead of one per queued write, and no header-only first segment.
                var chunks = [Data]()
                if let opening = try session?.openingBytes() { chunks.append(opening) }
                for packet in waiting { chunks += try session?.encode(packet) ?? [] }
                for write in StreamCoalescer.coalesce(chunks) { transport?.send(write) }
            } else {
                if let opening = try session?.openingBytes() { transport?.send(opening) }
                for packet in waiting { try transmit(packet) }
            }
            if finishPending { try finishTransportWriting() }
            onReady?()
        } catch { fail(error) }
    }

    private func sendOnQueue(_ data: Data) {
        guard !closed else { return }
        guard !writeEnded else { fail(ProxyError.closed); return }
        guard datagram || !data.isEmpty else { return }
        guard ready else {
            guard pending.count < 1024, pendingBytes + data.count <= 512 * 1024 else {
                fail(ProxyError.bufferLimit); return
            }
            pending.append(data); pendingBytes += data.count; return
        }
        do { try transmit(data) } catch { fail(error) }
    }

    /// True when the transport is a byte stream (TCP, optionally TLS/WebSocket), so wire
    /// chunks may be merged into fewer writes. False for a UDP socket: one write, one datagram.
    private var streamWrites: Bool { plan?.dial == .tcp }

    private func transmit(_ data: Data) throws {
        let chunks = try session?.encode(data) ?? []
        for chunk in streamWrites ? StreamCoalescer.coalesce(chunks) : chunks { transport?.send(chunk) }
    }

    private func finishWritingOnQueue() {
        guard !closed, !writeEnded, !datagram else { return }
        writeEnded = true; finishPending = true
        guard ready else { return }
        do { try finishTransportWriting() } catch { fail(error) }
    }

    private func finishTransportWriting() throws {
        finishPending = false
        if let closing = try session?.closingBytes() { transport?.send(closing) }
        // RFC6455 has no independent write EOF. VMess's encrypted termination
        // packet closes that direction while the WebSocket remains available for replies;
        // Trojan over WebSocket has no such signal and keeps the write side open.
        if plan?.framingCarriesEOF == true { transport?.finishWriting() }
    }

    private func receive(_ data: Data) {
        guard !closed else { return }
        guard let session else { return }
        do {
            for chunk in try session.decode(data) { onData?(chunk) }
            if session.remoteEnded { closeOnQueue() }
        } catch { fail(error) }
    }

    private func transportClosed() {
        guard !closed else { return }
        do {
            try session?.transportEnded()
            closeOnQueue()
        } catch { fail(error) }
    }

    private func fail(_ error: Error) {
        guard !closed else { return }
        onError?(error)
        closeOnQueue()
    }

    private func closeOnQueue() {
        guard !closed else { return }
        closed = true; ready = false
        timeout?.cancel(); timeout = nil
        pending.removeAll(); pendingBytes = 0
        transport?.close(); transport = nil
        onClose?()
    }
}
#endif
