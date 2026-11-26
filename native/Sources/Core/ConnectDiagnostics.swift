import Foundation

/// Plain-language reasons for a failed VPN connection. Everything here is pure so it is
/// unit-tested without a Mac, and none of it touches the MockMini-derived proxy core
/// (`Sources/Packet`, `Sources/VPN`): it only explains what that core already reported.
enum ConnectDiagnostics {
    static let probeBase = "No resolved VPN endpoint passed the authenticated HTTP proxy probe."
    static let fakeIPMessage = "The VPN server's name resolved to a Clash-style fake IP address (198.18.x.x), so another VPN or proxy tool is still intercepting DNS on this Mac. Quit Clash completely (turn off TUN or enhanced mode), then connect again."

    /// Clash, mihomo and sing-box answer DNS with "fake IP" addresses from 198.18.0.0/15
    /// while their TUN or enhanced mode is on. Dialing one can never reach the real server.
    static func isFakeIP(_ address: String) -> Bool {
        let parts = address.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        var octets = [Int]()
        for part in parts {
            guard let value = Int(part), (0...255).contains(value) else { return false }
            octets.append(value)
        }
        return octets[0] == 198 && (octets[1] == 18 || octets[1] == 19)
    }

    /// The reason each endpoint probe failed, without repeats, so a failed connect says why
    /// instead of one fixed sentence. At most three distinct reasons of 120 characters each.
    static func probeFailure(_ errors: [Error]) -> String {
        var reasons = [String]()
        for error in errors {
            var text = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.count > 120 { text = String(text.prefix(120)) }
            if !text.isEmpty, !reasons.contains(text) { reasons.append(text) }
            if reasons.count == 3 { break }
        }
        return reasons.isEmpty ? probeBase : probeBase + " Last error: " + reasons.joined(separator: "; ") + "."
    }

    /// DNS inside the tunnel is sent to the node as UDP, so a node that the subscription does
    /// not mark `udp: true` cannot resolve names even though the proxy itself is reachable.
    static func tunnelVerification(_ detail: String, nodeAllowsUDP: Bool) -> String {
        var text = "Traffic through the native tunnel could not be verified: \(detail)"
        if !nodeAllowsUDP {
            text += " The selected node is not marked udp: true in the subscription, and the tunnel sends DNS lookups to it as UDP, so names cannot be resolved. Choose a node that has UDP enabled."
        }
        return text
    }
}
