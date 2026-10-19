import Foundation

/// Maps the documented legacy JSON models into the native application's model.
/// Input is already restricted by LegacyStore; credentials/cookies are excluded.
enum LegacyMigration {
    struct Result {
        let state: [String: Any]
        let notes: [String]
    }
    static func transform(_ values: [String: String]) throws -> Result {
        var state: [String: Any] = [:], notes: [String] = []
        func object(_ key: String) throws -> [String: Any] {
            guard let text = values[key] else { return [:] }
            guard let data = text.data(using: .utf8), data.count <= 16 * 1024 * 1024,
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw AppError("The saved \(key) has an unexpected format; migration was not applied.") }
            return object
        }
        func rows(_ value: Any?, field: String) throws -> [[String: Any]] {
            guard let value, !(value is NSNull) else { return [] }
            guard let rows = value as? [[String: Any]], rows.count <= 100000 else { throw AppError("The saved \(field) has an unexpected format; migration was not applied.") }
            return rows
        }
        func string(_ item: [String: Any], _ key: String) -> String? {
            if let value = item[key] as? String { return value }
            if let value = item[key] as? NSNumber { return value.stringValue }
            return nil
        }
        func identifier(_ item: [String: Any], prefix: String, index: Int) -> String {
            string(item, "id").flatMap { $0.isEmpty ? nil : $0 } ?? "legacy-\(prefix)-\(index)"
        }
        let schedule = try object("wlsaplus:schedule"), progress = try object("wlsaplus:progress")
        var courses: [[String: Any]] = [], positions: [String: Int] = [:]
        for original in try rows(schedule["courses"], field: "schedule courses") + rows(progress["courses"], field: "progress courses") {
            var item = original
            let id = identifier(item, prefix: "course", index: courses.count)
            item["id"] = id
            if let position = positions[id] {
                var merged = courses[position]
                for (key, value) in item { merged[key] = value }
                courses[position] = merged
            } else { positions[id] = courses.count; courses.append(item) }
        }
        var sessions: [[String: Any]] = []
        for (index, original) in try rows(schedule["sessions"], field: "schedule sessions").enumerated() {
            var item = original
            item["id"] = identifier(original, prefix: "session", index: index)
            item["title"] = string(original, "courseName") ?? ""
            item["start"] = original["startsAt"] ?? ""
            item["end"] = original["endsAt"] ?? ""
            sessions.append(item)
        }
        var assignments: [[String: Any]] = []
        for course in courses {
            guard let detail = course["details"] else { continue }
            guard detail is NSNull || detail is [String: Any] else { throw AppError("Saved course details have an unexpected format; migration was not applied.") }
            let details = detail as? [String: Any] ?? [:]
            for original in try rows(details["assignments"], field: "course assignments") {
                var item = original
                item["id"] = identifier(original, prefix: "assignment", index: assignments.count)
                item["title"] = string(original, "name") ?? ""
                item["course"] = string(course, "name") ?? ""
                item["courseId"] = course["id"] ?? ""
                for (old, new) in [("dueDate", "due"), ("pointsEarned", "score"), ("pointsPossible", "total"), ("letterGrade", "grade"), ("isLate", "late"), ("isMissing", "missing"), ("isExempt", "exempt"), ("isIncomplete", "incomplete")] {
                    if let value = original[old] { item[new] = value }
                }
                assignments.append(item)
            }
        }
        var attendance: [[String: Any]] = []
        for (index, original) in try rows(progress["attendanceEvents"], field: "attendance events").enumerated() {
            var item = original
            item["id"] = identifier(original, prefix: "attendance", index: index)
            item["course"] = string(original, "courseName") ?? ""
            item["status"] = string(original, "label") ?? string(original, "kind") ?? ""
            attendance.append(item)
        }
        if values["wlsaplus:schedule"] != nil || values["wlsaplus:progress"] != nil {
            var snapshot: [String: Any] = ["courses": courses, "schedule": sessions, "assignments": assignments, "attendance": attendance]
            let timestamps = [schedule["syncedAt"] as? String, progress["syncedAt"] as? String].compactMap { $0 }
            let formatter = ISO8601DateFormatter()
            let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let ordered = timestamps.compactMap { value -> (Date, String)? in
                (formatter.date(from: value) ?? fractional.date(from: value)).map { ($0, value) }
            }.sorted { $0.0 > $1.0 }
            if let latest = ordered.first?.1 ?? timestamps.last { snapshot["syncedAt"] = latest }
            state["snapshot"] = snapshot
            state["school"] = [String: String]()
            notes.append("Cached school data was preserved. Sign in once to reconnect; passwords and cookies were not imported.")
        }
        let colors = ["default": "#00677a", "red": "#b9363e", "orange": "#bd5b12", "yellow": "#8c710c", "green": "#287a50", "blue": "#315fbc", "purple": "#7754ae", "pink": "#b43d82", "rose": "#ad4b63"]
        if let raw = values["wlsaplus:todos"] {
            guard let data = raw.data(using: .utf8), data.count <= 16 * 1024 * 1024 else { throw AppError("The saved to-dos are too large.") }
            let original = try rows(JSONSerialization.jsonObject(with: data), field: "to-dos")
            let icons = ["assignment": "📝", "menu_book": "📚", "school": "📚", "check": "✓", "check_circle": "✓", "flag": "🎯", "lightbulb": "💡", "notifications": "🔔", "directions_run": "🏃", "star": "⭐"]
            var todos: [[String: Any]] = [], seen = Set<String>()
            for (index, value) in original.enumerated() {
                var todo = value
                guard let title = value["title"] as? String, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AppError("A saved to-do has no title; migration was not applied.") }
                let id = identifier(value, prefix: "todo", index: index)
                guard seen.insert(id).inserted else { throw AppError("Saved to-do identifiers conflict; migration was not applied.") }
                todo["id"] = id
                if let color = value["color"] as? String { todo["legacyColor"] = color; todo["color"] = colors[color] ?? color }
                if let icon = value["icon"] as? String { todo["legacyIcon"] = icon; todo["icon"] = icons[icon] ?? (["✓", "📚", "📝", "🎯", "💡", "🔔", "🏃", "⭐"].contains(icon) ? icon : "✓") }
                todo["done"] = value["done"] ?? value["completed"] ?? false
                todos.append(todo)
            }
            state["todos"] = todos
        }
        let settings = try object("wlsaplus:settings")
        if let theme = settings["theme"] as? String, ["system", "light", "dark"].contains(theme) { state["appearance"] = theme }
        if let color = settings["color"] as? String, colors[color] != nil { state["accent"] = color }
        for (old, new) in [("tuningEnabled", "tuningEnabled"), ("tunedTime", "tunedTime"), ("classRemindersEnabled", "reminders")] {
            if let value = settings[old] { state[new] = value }
        }
        for (old, new) in [("wlsaplus:vpn-node", "vpnNode"), ("wlsaplus:vpn-source", "vpnSource")] {
            if let text = values[old] {
                let decoded = text.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed]) } as? String
                state[new] = decoded ?? text
            }
        }
        guard JSONSerialization.isValidJSONObject(state) else { throw AppError("The migrated cache could not be represented safely.") }
        return Result(state: state, notes: notes)
    }
}
