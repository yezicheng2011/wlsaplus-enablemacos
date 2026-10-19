import Foundation

enum LegacyStoreTests {
    static func rejects(_ operation: () throws -> Void) throws {
        do { try operation() } catch { return }
        throw AppError("Expected a malformed fixture to fail")
    }
    static func run() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/Legacy", isDirectory: true)
        let snapshot = try LegacyStore.read(directory: root.appendingPathComponent("valid"))
        assert(snapshot.values["wlsaplus:todos"] == "[\"new\"]")
        assert(snapshot.values["wlsaplus:settings"] == "{\"label\":\"学校 café\"}")
        assert(snapshot.values["wlsaplus:schedule"] == "[\"Tue\"]")
        assert(snapshot.values["wlsaplus:progress"] == nil)
        assert(snapshot.values["wlsaplus:vpn-source"] == "policy")
        assert(snapshot.values["wlsaplus:vpn-node"] == "NodeA")
        assert(snapshot.values.count == 5 && snapshot.warnings.isEmpty)
        for name in ["bad-crc", "bad-table", "missing"] {
            try rejects { _ = try LegacyStore.read(directory: root.appendingPathComponent(name)) }
        }
        let partial = try LegacyStore.read(directory: root.appendingPathComponent("partial"))
        assert(partial.values == snapshot.values && partial.warnings.count == 1)
        let fragmented = try LegacyStore.read(directory: root.appendingPathComponent("fragmented"))
        assert(fragmented.values["wlsaplus:todos"] == String(repeating: "x", count: 70000))
        let snappy24 = try LegacyStore.snappy([11, 8, 97, 98, 99, 17, 3])
        assert(snappy24 == Array("abcabcabcab".utf8))
        let snappy25 = try LegacyStore.snappy([7, 8, 120, 97, 98, 14, 2, 0])
        assert(snappy25 == Array("xababab".utf8))
        let snappy26 = try LegacyStore.snappy([7, 8, 120, 97, 98, 15, 2, 0, 0, 0])
        assert(snappy26 == Array("xababab".utf8))
        let snappy27 = try LegacyStore.snappy([65, 0, 120, 254, 1, 0])
        assert(snappy27 == Array(repeating: UInt8(120), count: 65))
        let snappy28 = try LegacyStore.snappy([61, 240, 60] + Array(repeating: 42, count: 61))
        assert(snappy28 == Array(repeating: 42, count: 61))
        for bytes: [UInt8] in [[1, 2, 0, 0], [1, 1, 1], [3, 0, 65], [0, 0, 1], [255,255,255,255,255,255,255,255,255,2]] {
            try rejects { _ = try LegacyStore.snappy(bytes) }
        }
        let schedule: [String: Any] = ["syncedAt": "2026-10-19T10:00:00Z", "courses": [["id": "c1", "name": "Math", "teacher": "Ms A"]], "sessions": [["id": "s1", "courseName": "Math", "startsAt": "2026-10-20T09:00:00Z", "endsAt": "2026-10-20T10:00:00Z", "room": "5218"]]]
        let progress: [String: Any] = ["courses": [["id": "c1", "name": "Math", "grade": "A", "details": ["description": "Numbers", "assignments": [["id": "a1", "name": "Homework", "description": "Read pages 1–2", "dueDate": "2026-10-21", "pointsEarned": 9, "pointsPossible": 10, "isLate": false]]]]], "attendanceEvents": [["id": "e1", "date": "2026-10-18", "courseName": "Math", "label": "Present", "count": 2]]]
        func encoded(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self) }
        let migrated = try LegacyMigration.transform(["wlsaplus:schedule": encoded(schedule), "wlsaplus:progress": encoded(progress), "wlsaplus:todos": encoded([["id": "t1", "title": "Read", "details": "Keep this detail", "color": "red", "icon": "menu_book", "timeType": "deadline"]]), "wlsaplus:settings": encoded(["theme": "dark", "color": "blue", "classRemindersEnabled": false]), "wlsaplus:vpn-node": "NodeA"])
        let cache = migrated.state["snapshot"] as! [String: Any]
        let courses = cache["courses"] as! [[String: Any]], assignments = cache["assignments"] as! [[String: Any]], attendance = cache["attendance"] as! [[String: Any]], sessions = cache["schedule"] as! [[String: Any]], todos = migrated.state["todos"] as! [[String: Any]]
        assert(courses.count == 1 && courses[0]["teacher"] as? String == "Ms A" && courses[0]["grade"] as? String == "A")
        assert(assignments[0]["title"] as? String == "Homework" && assignments[0]["score"] as? Int == 9 && assignments[0]["total"] as? Int == 10 && assignments[0]["description"] as? String == "Read pages 1–2")
        assert(attendance[0]["status"] as? String == "Present" && attendance[0]["count"] as? Int == 2)
        assert(sessions[0]["title"] as? String == "Math" && sessions[0]["start"] as? String == "2026-10-20T09:00:00Z")
        assert(todos[0]["details"] as? String == "Keep this detail" && todos[0]["icon"] as? String == "📚" && todos[0]["color"] as? String == "#b9363e")
        assert(migrated.state["appearance"] as? String == "dark" && migrated.state["reminders"] as? Bool == false && migrated.state["vpnNode"] as? String == "NodeA")
        assert((migrated.state["school"] as? [String: String])?.isEmpty == true && migrated.notes.count == 1)
        try rejects { _ = try LegacyMigration.transform(["wlsaplus:todos": "{bad json"]) }
        print("legacy tests passed: active inventory, obsolete files, tombstones, both text encodings, WAL fragmentation, CRC/corruption, Snappy copy types; migration models/details/settings")
    }
}
