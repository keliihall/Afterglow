import Foundation

/// Reads/writes the SAME `~/.ai-usage-widget/config.json` as the Electron build,
/// so settings carry over between the two. We keep the raw dictionary and mutate
/// only the keys we touch, preserving anything else the file contains.
final class Config {
    static let shared = Config()

    static let path = (NSHomeDirectory() as NSString)
        .appendingPathComponent(".ai-usage-widget/config.json")

    private var root: [String: Any]

    private init() {
        root = Config.read() ?? [:]
    }

    private static func read() -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return obj
    }

    func reload() { root = Config.read() ?? root }

    private func save() {
        let dir = (Config.path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: Config.path))
        }
    }

    // MARK: typed accessors (with Electron-matching defaults)

    var refreshSeconds: Double {
        get { (root["refreshSeconds"] as? NSNumber)?.doubleValue ?? 20 }
        set { root["refreshSeconds"] = newValue; save() }
    }

    var display: String { // "all" / "codex" / "claude"
        get { (root["display"] as? String) ?? "all" }
        set { root["display"] = newValue; save() }
    }

    var size: String { // "small" / "medium" / "large"
        get { (root["size"] as? String) ?? "medium" }
        set { root["size"] = newValue; save() }
    }

    private func provider(_ name: String) -> [String: Any] {
        (root["providers"] as? [String: Any])?[name] as? [String: Any] ?? [:]
    }

    var codexEnabled: Bool { (provider("codex")["enabled"] as? Bool) ?? true }
    var codexLive: Bool { (provider("codex")["live"] as? Bool) ?? true }
    var claudeEnabled: Bool { (provider("claude")["enabled"] as? Bool) ?? true }
    var claudeShowScoped: Bool { (provider("claude")["showScoped"] as? Bool) ?? true }
    var claudeMinRefresh: Double { (provider("claude")["minRefreshSeconds"] as? NSNumber)?.doubleValue ?? 90 }

    var wantCodex: Bool { display != "claude" && codexEnabled }
    var wantClaude: Bool { display != "codex" && claudeEnabled }
}
