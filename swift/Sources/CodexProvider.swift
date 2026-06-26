import Foundation

/// Codex usage. Prefers the live account total via `codex app-server`
/// (`account/rateLimits/read`, the same data as `/status`); falls back to the
/// session logs' account pool when the app-server is unavailable.
actor CodexProvider {
    static let shared = CodexProvider()

    private struct Live { var windows: [UsageWindow]; var plan: String?; var at: Date }
    private var liveCache: Live?
    private var liveAttemptAt: Date?
    private var liveInFlight: Task<Live?, Never>?
    private let liveMin: TimeInterval = 90

    func usage(live: Bool) async -> ProviderUsage {
        if live, let snap = await fetchLive() {
            return ProviderUsage(id: "codex", label: "Codex", status: .ok,
                                 statusText: "正常 · 账号总额 · 实时", planType: snap.plan,
                                 realtime: true, updatedAt: snap.at, windows: snap.windows)
        }
        return fromSessionLogs()
    }

    // MARK: - live (app-server)

    private func fetchLive() async -> Live? {
        let now = Date()
        if let a = liveAttemptAt, now.timeIntervalSince(a) < liveMin {
            if let t = liveInFlight { return await t.value }
            return liveCache
        }
        liveAttemptAt = now
        let task = Task { await self.runAppServer() }
        liveInFlight = task
        let result = await task.value
        liveInFlight = nil
        if let r = result { liveCache = r }
        return result ?? liveCache
    }

    private func runAppServer() async -> Live? {
        guard let result = await Self.appServerRateLimits(),
              let snap = Self.pickAccountSnapshot(result) else { return nil }
        guard snap["primary"] != nil || snap["secondary"] != nil else { return nil }
        let plan = (snap["planType"] as? String) ?? (snap["plan_type"] as? String)
        let windows = [Self.liveWindow("5h", "5h", snap["primary"]),
                       Self.liveWindow("1w", "1w", snap["secondary"])]
        return Live(windows: windows, plan: plan, at: Date())
    }

    private static func liveWindow(_ id: String, _ label: String, _ raw: Any?) -> UsageWindow {
        guard let w = raw as? [String: Any] else {
            return UsageWindow(id: id, label: label, usedPercent: nil, resetsAt: nil)
        }
        let used = (w["usedPercent"] as? NSNumber)?.doubleValue ?? (w["used_percent"] as? NSNumber)?.doubleValue
        let reset = resetDate(w["resetsAt"] ?? w["resets_at"])
        return UsageWindow(id: id, label: label, usedPercent: used, resetsAt: reset)
    }

    private static func pickAccountSnapshot(_ result: [String: Any]) -> [String: Any]? {
        if let rl = result["rateLimits"] as? [String: Any], rl["primary"] != nil || rl["secondary"] != nil {
            return rl
        }
        if let map = result["rateLimitsByLimitId"] as? [String: Any] {
            if let codex = map["codex"] as? [String: Any] { return codex }
            for (_, v) in map {
                if let s = v as? [String: Any], s["limitName"] == nil, (s["primary"] != nil || s["secondary"] != nil) {
                    return s
                }
            }
        }
        return nil
    }

    /// Drive `codex app-server` (stdio JSON-RPC): initialize → account/rateLimits/read.
    private static func appServerRateLimits() async -> [String: Any]? {
        await withCheckedContinuation { (cont: CheckedContinuation<[String: Any]?, Never>) in
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: resolveCodexBin())
            proc.arguments = ["app-server"]
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "")
            proc.environment = env
            let inPipe = Pipe(), outPipe = Pipe()
            proc.standardInput = inPipe
            proc.standardOutput = outPipe
            proc.standardError = FileHandle.nullDevice

            let lock = NSLock()
            var finished = false
            var buffer = Data()

            func finish(_ v: [String: Any]?) {
                lock.lock(); defer { lock.unlock() }
                if finished { return }
                finished = true
                outPipe.fileHandleForReading.readabilityHandler = nil
                proc.terminationHandler = nil
                if proc.isRunning { proc.terminate() }
                cont.resume(returning: v)
            }
            func send(_ obj: [String: Any]) {
                guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
                var line = d; line.append(0x0A)
                try? inPipe.fileHandleForWriting.write(contentsOf: line)
            }

            outPipe.fileHandleForReading.readabilityHandler = { fh in
                let chunk = fh.availableData
                if chunk.isEmpty { return }
                buffer.append(chunk)
                while let nl = buffer.firstIndex(of: 0x0A) {
                    let lineData = buffer.subdata(in: buffer.startIndex..<nl)
                    buffer.removeSubrange(buffer.startIndex...nl)
                    guard let msg = (try? JSONSerialization.jsonObject(with: lineData)) as? [String: Any] else { continue }
                    let id = (msg["id"] as? NSNumber)?.intValue
                    if id == 1, msg["result"] != nil {
                        send(["jsonrpc": "2.0", "method": "initialized", "params": [:]])
                        send(["jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": [:]])
                    } else if id == 2 {
                        finish(msg["result"] as? [String: Any])
                    }
                }
            }
            proc.terminationHandler = { _ in finish(nil) }
            do { try proc.run() } catch { finish(nil); return }
            send(["jsonrpc": "2.0", "id": 1, "method": "initialize",
                  "params": ["clientInfo": ["name": "afterglow", "version": "0.2.0"]]])
            DispatchQueue.global().asyncAfter(deadline: .now() + 15) { finish(nil) }
        }
    }

    private static func resolveCodexBin() -> String {
        let home = NSHomeDirectory()
        for c in ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", home + "/.codex/bin/codex"] {
            if FileManager.default.fileExists(atPath: c) { return c }
        }
        return "codex"
    }

    // MARK: - session-log fallback

    private struct Entry { var ts: Date; var rl: [String: Any]; var account: Bool }

    private func fromSessionLogs() -> ProviderUsage {
        let dir = (NSHomeDirectory() as NSString).appendingPathComponent(".codex/sessions")
        var latestAccount: Entry?
        var latestAny: Entry?

        for file in Self.jsonlFiles(dir).prefix(80) {
            guard let text = try? String(contentsOfFile: file, encoding: .utf8) else { continue }
            for line in text.split(separator: "\n") {
                if !line.contains("\"rate_limits\"") { continue }
                guard let data = line.data(using: .utf8),
                      let e = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      (e["type"] as? String) == "event_msg",
                      let payload = e["payload"] as? [String: Any],
                      (payload["type"] as? String) == "token_count" else { continue }
                guard let rl = (e["rate_limits"] as? [String: Any]) ?? (payload["rate_limits"] as? [String: Any]) else { continue }
                let ts = Self.parseTS(e["timestamp"])
                let entry = Entry(ts: ts, rl: rl, account: Self.isAccountPool(rl))
                if latestAny == nil || ts > latestAny!.ts { latestAny = entry }
                if entry.account, latestAccount == nil || ts > latestAccount!.ts { latestAccount = entry }
            }
        }

        guard let latest = latestAccount ?? latestAny else {
            return ProviderUsage.missing(id: "codex", label: "Codex", text: "未找到 Codex rate_limits")
        }
        let win: ([String: Any]?, String) -> UsageWindow = { raw, id in
            guard let w = raw else { return UsageWindow(id: id, label: id, usedPercent: nil, resetsAt: nil) }
            let used = (w["used_percent"] as? NSNumber)?.doubleValue
            return UsageWindow(id: id, label: id, usedPercent: used, resetsAt: Self.resetDate(w["resets_at"]))
        }
        let reached = (latest.rl["rate_limit_reached_type"] != nil) ? "已触限" : "正常"
        let text = latest.account ? "\(reached) · 账号总额（日志·实时不可用）" : "\(reached) · 子模型（日志）"
        return ProviderUsage(id: "codex", label: "Codex", status: .ok, statusText: text,
                             planType: latest.rl["plan_type"] as? String, realtime: false,
                             updatedAt: latest.ts,
                             windows: [win(latest.rl["primary"] as? [String: Any], "5h"),
                                       win(latest.rl["secondary"] as? [String: Any], "1w")])
    }

    private static func isAccountPool(_ rl: [String: Any]) -> Bool {
        if let id = rl["limit_id"] as? String, id != "codex" { return false }
        let name = rl["limit_name"]
        return name == nil || (name as? String)?.isEmpty == true
    }

    private static func jsonlFiles(_ root: String) -> [String] {
        let fm = FileManager.default
        guard let en = fm.enumerator(atPath: root) else { return [] }
        var files: [(String, Date)] = []
        let cutoff = Date().addingTimeInterval(-8 * 86400)
        while let rel = en.nextObject() as? String {
            guard rel.hasSuffix(".jsonl") else { continue }
            let full = (root as NSString).appendingPathComponent(rel)
            guard let attrs = try? fm.attributesOfItem(atPath: full),
                  let m = attrs[.modificationDate] as? Date, m >= cutoff else { continue }
            files.append((full, m))
        }
        return files.sorted { $0.1 > $1.1 }.map { $0.0 }
    }

    private static func parseTS(_ v: Any?) -> Date {
        guard let s = v as? String else { return .distantPast }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s) ?? .distantPast
    }

    private static func resetDate(_ v: Any?) -> Date? {
        if let n = (v as? NSNumber)?.doubleValue {
            return Date(timeIntervalSince1970: n > 1e12 ? n / 1000 : n)
        }
        if let s = v as? String { return ISO8601DateFormatter().date(from: s) }
        return nil
    }
}
