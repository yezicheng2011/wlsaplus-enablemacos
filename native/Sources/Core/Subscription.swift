import Foundation

// A deliberately bounded importer for the subscription's node schema. This is
// original parsing code, not a general YAML runtime. No tags, anchors or includes
// are evaluated and subscription routes/commands never become executable input.
struct SubscriptionImporter {
    static func nodes(_ text: String) throws -> [[String: Any]] {
        guard text.utf8.count <= 2 * 1024 * 1024 else { throw AppError("Subscription exceeds 2 MB.") }
        if let data = text.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let nodes = obj["proxies"] as? [[String: Any]] {
            return try normalize(nodes)
        }
        let lines = text.components(separatedBy: .newlines)
        guard let start = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "proxies:" }) else {
            throw AppError("Subscription must contain a proxies node list.")
        }
        var result: [[String: Any]] = [], block: [(Int, String)] = []
        func finish() throws {
            if block.isEmpty { return }
            var index = 0
            result.append(try parseBlock(block, index: &index, indent: block[0].0))
            block.removeAll(keepingCapacity: true)
        }
        for raw in lines.dropFirst(start + 1) {
            let stripped = raw.trimmingCharacters(in: .whitespaces)
            if stripped.isEmpty || stripped.hasPrefix("#") { continue }
            let indent = raw.prefix(while: { $0 == " " }).count
            if indent == 0 { break }
            guard !raw.contains("\t") else { throw AppError("Tabs are not supported in subscription indentation.") }
            if stripped.hasPrefix("- ") {
                try finish()
                let item = String(stripped.dropFirst(2))
                if item.hasPrefix("{") {
                    var flow = FlowReader(item)
                    guard let map = try flow.value() as? [String: Any] else { throw AppError("Invalid subscription node.") }
                    try flow.finish()
                    result.append(map)
                } else { block.append((indent + 2, item)) }
            } else { block.append((indent, stripped)) }
            guard result.count < 2048 else { throw AppError("Too many subscription nodes.") }
        }
        try finish()
        return try normalize(result)
    }

    private static func parseBlock(_ lines: [(Int, String)], index: inout Int, indent: Int) throws -> [String: Any] {
        var map: [String: Any] = [:]
        while index < lines.count && lines[index].0 >= indent {
            guard lines[index].0 == indent else { throw AppError("Invalid subscription nesting.") }
            let line = lines[index].1
            guard let colon = line.firstIndex(of: ":") else { throw AppError("Invalid node property.") }
            let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
            let remaining = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty, map[key] == nil else { throw AppError("Duplicate or empty node property.") }
            index += 1
            if remaining.isEmpty, index < lines.count, lines[index].0 > indent {
                map[key] = try parseBlock(lines, index: &index, indent: lines[index].0)
            } else {
                var reader = FlowReader(remaining)
                map[key] = try reader.value()
                try reader.finish()
            }
        }
        return map
    }

    private static func normalize(_ nodes: [[String: Any]]) throws -> [[String: Any]] {
        var result: [[String: Any]] = [], seen = Set<String>()
        for p in nodes {
            guard let name = p["name"] as? String, !name.isEmpty, name.utf8.count <= 1024,
                  let server = p["server"] as? String, !server.isEmpty, server.utf8.count <= 253,
                  !server.contains(where: { $0.isWhitespace || $0.isNewline }),
                  let type = p["type"] as? String,
                  let number = p["port"] as? NSNumber, number.doubleValue == Double(number.intValue), (1...65535).contains(number.intValue) else {
                throw AppError("A subscription node is incomplete or invalid.")
            }
            guard seen.insert(name).inserted else { throw AppError("Subscription node names must be unique.") }
            let ws = p["ws-opts"] as? [String: Any] ?? [:], headers = ws["headers"] as? [String: Any] ?? [:]
            var normalized: [String: Any] = ["id": name, "name": name, "type": type, "server": server, "port": number.intValue]
            for (source, target) in [("cipher", "cipher"), ("password", "password"), ("uuid", "uuid"), ("alterId", "alterId"), ("tls", "tls"), ("servername", "serverName"), ("sni", "serverName"), ("skip-cert-verify", "skipCertVerify"), ("network", "network"), ("udp", "udp")] {
                if let item = p[source] { normalized[target] = item }
            }
            if let path = ws["path"] { normalized["wsPath"] = path }
            if let host = headers["Host"] ?? headers["host"] { normalized["wsHost"] = host }
            if p["plugin"] != nil { throw AppError("This subscription requires a plugin that has not been implemented.") }
            result.append(normalized)
        }
        guard !result.isEmpty else { throw AppError("Subscription returned no nodes.") }
        return result
    }
}

private struct FlowReader {
    let chars: [Character]
    var position = 0
    init(_ value: String) { chars = Array(value) }
    mutating func spaces() { while position < chars.count && chars[position].isWhitespace { position += 1 } }
    mutating func finish() throws {
        spaces()
        guard position == chars.count || chars[position] == "#" else { throw AppError("Trailing subscription data.") }
    }
    mutating func value(depth: Int = 0) throws -> Any {
        guard depth < 8 else { throw AppError("Subscription nesting is too deep.") }
        spaces()
        guard position < chars.count else { return "" }
        if chars[position] == "{" {
            position += 1
            var result: [String: Any] = [:]
            spaces()
            if position < chars.count && chars[position] == "}" { position += 1; return result }
            while position < chars.count {
                spaces()
                let key: String
                if chars[position] == "\"" || chars[position] == "'" { key = try quoted() }
                else {
                    let start = position
                    while position < chars.count && chars[position] != ":" { position += 1 }
                    key = String(chars[start..<position]).trimmingCharacters(in: .whitespaces)
                }
                spaces()
                guard !key.isEmpty, result[key] == nil, position < chars.count, chars[position] == ":" else { throw AppError("Invalid node flow mapping.") }
                position += 1
                result[key] = try value(depth: depth + 1)
                spaces()
                guard position < chars.count else { throw AppError("Incomplete node mapping.") }
                if chars[position] == "}" { position += 1; return result }
                guard chars[position] == "," else { throw AppError("Invalid node separator.") }
                position += 1
            }
            throw AppError("Unterminated node mapping.")
        }
        if chars[position] == "[" {
            position += 1
            var items: [Any] = []
            spaces()
            while position < chars.count && chars[position] != "]" {
                items.append(try value(depth: depth + 1)); spaces()
                if position < chars.count && chars[position] == "," { position += 1; spaces() }
                else { break }
            }
            guard position < chars.count && chars[position] == "]" else { throw AppError("Unterminated sequence.") }
            position += 1
            return items
        }
        if chars[position] == "'" || chars[position] == "\"" { return try quoted() }
        let start = position
        while position < chars.count && ![",", "}", "]"].contains(chars[position]) { position += 1 }
        let scalar = String(chars[start..<position]).trimmingCharacters(in: .whitespaces)
        guard !scalar.hasPrefix("!") && !scalar.hasPrefix("&") && !scalar.hasPrefix("*") else { throw AppError("YAML tags and aliases are not accepted.") }
        if scalar == "true" { return true }
        if scalar == "false" { return false }
        if matches(scalar, #"^[0-9]{1,10}$"#), let integer = Int(scalar) { return integer }
        return scalar
    }
    mutating func quoted() throws -> String {
        let quote = chars[position]
        position += 1
        var text = ""
        while position < chars.count {
            let c = chars[position]; position += 1
            if c == quote {
                if quote == "'", position < chars.count, chars[position] == "'" { text.append("'"); position += 1; continue }
                return text
            }
            if quote == "\"" && c == "\\" {
                guard position < chars.count else { break }
                let escaped = chars[position]; position += 1
                switch escaped {
                case "n": text.append("\n")
                case "r": text.append("\r")
                case "t": text.append("\t")
                case "\\", "\"", "/": text.append(escaped)
                case "u", "U":
                    let length = escaped == "u" ? 4 : 8
                    guard position + length <= chars.count, let code = UInt32(String(chars[position..<(position+length)]), radix: 16), let scalar = UnicodeScalar(code) else { throw AppError("Invalid Unicode escape.") }
                    text.unicodeScalars.append(scalar); position += length
                default: throw AppError("Unsupported string escape.")
                }
            } else { text.append(c) }
        }
        throw AppError("Unterminated subscription string.")
    }
}
