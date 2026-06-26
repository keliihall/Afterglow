import Foundation
import CommonCrypto
import Security

// Let our short Chinese reason strings flow through Result's Failure channel.
extension String: @retroactive Error {}

/// Claude usage via the official `/api/oauth/usage` endpoint, using the OAuth
/// token the Claude desktop app stores (Electron safeStorage–encrypted) in its
/// config.json + the "Claude Safe Storage" keychain key. Mirrors the Electron
/// provider: freshest-valid-token selection, attempt-anchored throttle,
/// exponential 429 backoff with jitter, single-flight, and a stale cache.
actor ClaudeProvider {
    static let shared = ClaudeProvider()

    private struct Good { var windows: [UsageWindow]; var plan: String?; var at: Date }

    private var lastGood: Good?
    private var lastAttemptAt: Date?
    private var lastAttemptOk = false
    private var nextAllowedAt: Date?
    private var consecutive429 = 0
    private var lastErrorText: String?
    private var inFlight: Task<ProviderUsage, Never>?

    private let endpoint = URL(string: "https://api.anthropic.com/api/oauth/usage")!
    private let staleMax: TimeInterval = 30 * 60
    private let backoffBase: TimeInterval = 60
    private let backoffCap: TimeInterval = 15 * 60

    func usage(minRefresh: Double, showScoped: Bool) async -> ProviderUsage {
        let now = Date()

        // 1) Backoff gate after a 429 — serve cache (stale), no network.
        if let until = nextAllowedAt, now < until {
            if let g = lastGood, now.timeIntervalSince(g.at) < staleMax {
                return cached(g, realtime: false, text: "请求过于频繁，已自动降低刷新")
            }
            return degradedNoCache("请求过于频繁(429)")
        }

        // 2) Throttle gate — at most one ATTEMPT per minRefresh; serve cache.
        if let a = lastAttemptAt, now.timeIntervalSince(a) < max(0, minRefresh) {
            if let g = lastGood {
                return cached(g, realtime: lastAttemptOk, text: lastAttemptOk ? "正常" : "数据偏旧")
            }
            if let err = lastErrorText { return degradedNoCache(err) }
            return ProviderUsage.missing(id: "claude", label: "Claude", text: "加载中…")
        }

        // 3) Single-flight — concurrent cold callers share one request.
        if let t = inFlight { return await t.value }
        let task = Task { await self.fetchAndStore(now: now, showScoped: showScoped) }
        inFlight = task
        let result = await task.value
        inFlight = nil
        return result
    }

    /// Re-trigger the keychain prompt on demand and reset throttle/backoff.
    func authorizeKeychain() -> (ok: Bool, reason: String) {
        TokenStore.resetKey()
        let r = TokenStore.probeKeychain()
        if r.ok {
            lastAttemptAt = nil; lastAttemptOk = false; nextAllowedAt = nil
            consecutive429 = 0; lastErrorText = nil; inFlight = nil
        }
        return r
    }

    // MARK: - private

    private func cached(_ g: Good, realtime: Bool, text: String) -> ProviderUsage {
        ProviderUsage(id: "claude", label: "Claude", status: .ok, statusText: text,
                      planType: g.plan, realtime: realtime, updatedAt: g.at, windows: g.windows)
    }

    private func degraded(_ text: String) -> ProviderUsage {
        lastErrorText = text
        if let g = lastGood, Date().timeIntervalSince(g.at) < staleMax {
            return cached(g, realtime: false, text: text)
        }
        return degradedNoCache(text)
    }

    private func degradedNoCache(_ text: String) -> ProviderUsage {
        ProviderUsage(id: "claude", label: "Claude", status: .error, statusText: text,
                      planType: nil, realtime: false, updatedAt: nil, windows: [])
    }

    private func applyBackoff(retryAfter: TimeInterval) {
        consecutive429 += 1
        let base = min(backoffCap, backoffBase * pow(2, Double(consecutive429 - 1)))
        let jittered = base / 2 + Double.random(in: 0...(base / 2))
        nextAllowedAt = Date().addingTimeInterval(max(jittered, retryAfter))
    }

    private func fetchAndStore(now: Date, showScoped: Bool) async -> ProviderUsage {
        lastAttemptAt = now
        var ok = false
        defer { lastAttemptOk = ok }

        let creds: TokenStore.Creds
        switch TokenStore.current() {
        case .success(let c): creds = c
        case .failure(let reason): return degraded(reason)
        }

        var req = URLRequest(url: endpoint, timeoutInterval: 15)
        req.setValue("Bearer \(creds.token)", forHTTPHeaderField: "Authorization")
        req.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        req.setValue("claude-cli/2.1.187 (external, cli)", forHTTPHeaderField: "User-Agent")

        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse else {
            return degraded("网络错误")
        }
        let code = http.statusCode
        if code == 401 || code == 403 { return degraded("登录已过期，请在 Claude 里重新登录") }
        if code == 429 {
            let ra = (http.value(forHTTPHeaderField: "retry-after")).flatMap { Double($0) } ?? 0
            applyBackoff(retryAfter: ra > 0 ? ra : 0)
            return degraded("请求过于频繁(429)")
        }
        guard code == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return degraded("数据读取失败(\(code))")
        }

        consecutive429 = 0
        nextAllowedAt = nil
        lastErrorText = nil
        let windows = Self.parse(obj, showScoped: showScoped)
        let g = Good(windows: windows, plan: creds.tier.isEmpty ? nil : creds.tier, at: now)
        lastGood = g
        ok = true
        return ProviderUsage(id: "claude", label: "Claude", status: .ok, statusText: "正常",
                             planType: g.plan, realtime: true, updatedAt: now, windows: windows)
    }

    // MARK: - parse

    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()
    private static func date(_ v: Any?) -> Date? {
        guard let s = v as? String else { return nil }
        return isoFrac.date(from: s) ?? iso.date(from: s)
    }

    static func parse(_ obj: [String: Any], showScoped: Bool) -> [UsageWindow] {
        var out: [UsageWindow] = []
        if let limits = obj["limits"] as? [[String: Any]] {
            for l in limits {
                let kind = l["kind"] as? String ?? ""
                let pct = (l["percent"] as? NSNumber)?.doubleValue ?? 0
                let reset = date(l["resets_at"])
                switch kind {
                case "session": out.append(UsageWindow(id: "5h", label: "5h", usedPercent: pct, resetsAt: reset))
                case "weekly_all": out.append(UsageWindow(id: "1w", label: "1w", usedPercent: pct, resetsAt: reset))
                case "weekly_scoped":
                    if showScoped, pct > 0 {
                        let scope = l["scope"] as? [String: Any]
                        let model = (scope?["model"] as? [String: Any])?["display_name"] as? String ?? "scoped"
                        out.append(UsageWindow(id: "scoped-\(model)", label: model, usedPercent: pct, resetsAt: reset))
                    }
                default: break
                }
            }
        }
        if !out.contains(where: { $0.id == "5h" }) {
            out.insert(UsageWindow(id: "5h", label: "5h", usedPercent: nil, resetsAt: nil), at: 0)
        }
        if !out.contains(where: { $0.id == "1w" }) {
            let i = out.firstIndex { $0.id != "5h" } ?? out.count
            out.insert(UsageWindow(id: "1w", label: "1w", usedPercent: nil, resetsAt: nil), at: i)
        }
        let order: [String: Int] = ["5h": 0, "1w": 1]
        return out.sorted { (order[$0.id] ?? 2) < (order[$1.id] ?? 2) }
    }
}

// MARK: - OAuth token store (keychain + safeStorage)

enum TokenStore {
    struct Creds { let token: String; let tier: String }

    private static let configPath = (NSHomeDirectory() as NSString)
        .appendingPathComponent("Library/Application Support/Claude/config.json")
    private static var cachedKey: [UInt8]?

    static func resetKey() { cachedKey = nil }

    /// One probe used by the "authorize keychain" menu action.
    static func probeKeychain() -> (ok: Bool, reason: String) {
        var out: AnyObject?
        let st = SecItemCopyMatching(keychainQuery as CFDictionary, &out)
        if st == errSecSuccess { return (true, "") }
        if st == errSecItemNotFound { return (false, "未检测到 Claude 密钥（请先安装并登录 Claude 桌面端）") }
        return (false, "未授权（请在钥匙串弹窗点“始终允许 / Always Allow”）")
    }

    static func current() -> Result<Creds, String> {
        guard let data = FileManager.default.contents(atPath: configPath),
              let cfg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .failure("未检测到 Claude 桌面端（请先安装并登录）")
        }
        switch derivedKey() {
        case .failure(let r): return .failure(r)
        case .success(let key):
            if let c = extractCreds(cfg, key: key) { return .success(c) }
            cachedKey = nil
            switch derivedKey() {
            case .failure(let r): return .failure(r)
            case .success(let k2):
                if let c = extractCreds(cfg, key: k2) { return .success(c) }
                return .failure("Claude 登录信息为空（请重新登录 Claude）")
            }
        }
    }

    private static func derivedKey() -> Result<[UInt8], String> {
        if let k = cachedKey { return .success(k) }
        var out: AnyObject?
        let st = SecItemCopyMatching(keychainQuery as CFDictionary, &out)
        if st == errSecItemNotFound {
            return .failure("未检测到 Claude 密钥（请先安装并登录 Claude 桌面端）")
        }
        guard st == errSecSuccess, let pw = out as? Data else {
            return .failure("钥匙串未授权（托盘菜单点“授权读取 Claude 余量”，弹窗选“始终允许”）")
        }
        let k = pbkdf2SHA1(password: [UInt8](pw), salt: Array("saltysalt".utf8), iterations: 1003, keyLen: 16)
        guard !k.isEmpty else { return .failure("钥匙串密钥派生失败") }
        cachedKey = k
        return .success(k)
    }

    private static var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "Claude Safe Storage",
         kSecReturnData as String: true,
         kSecMatchLimit as String: kSecMatchLimitOne]
    }

    /// Collect every entry across tokenCacheV2 + tokenCache, then pick the best:
    /// not-expired first, then the claude_code scope, then the furthest expiry.
    private static func extractCreds(_ cfg: [String: Any], key: [UInt8]) -> Creds? {
        struct Cand { let token: String; let tier: String; let isCC: Bool; let exp: Double; let v2: Bool }
        var cands: [Cand] = []
        for (ck, v2) in [("oauth:tokenCacheV2", true), ("oauth:tokenCache", false)] {
            guard let enc = cfg[ck] as? String,
                  let plain = decryptSafeStorage(enc, key: key),
                  let cache = try? JSONSerialization.jsonObject(with: plain) as? [String: Any] else { continue }
            for (composite, value) in cache {
                guard let v = value as? [String: Any], let token = v["token"] as? String else { continue }
                cands.append(Cand(token: token,
                                  tier: v["subscriptionType"] as? String ?? "",
                                  isCC: composite.contains("claude_code"),
                                  exp: expiry(v["expiresAt"]),
                                  v2: v2))
            }
        }
        guard !cands.isEmpty else { return nil }
        let now = Date().timeIntervalSince1970 * 1000
        let skew: Double = 60 * 1000
        let fresh = cands.filter { $0.exp > now + skew }
        let pool = fresh.isEmpty ? cands : fresh
        let best = pool.sorted {
            if $0.isCC != $1.isCC { return $0.isCC && !$1.isCC }
            if $0.exp != $1.exp { return $0.exp > $1.exp }
            return $0.v2 && !$1.v2
        }.first!
        return Creds(token: best.token, tier: best.tier)
    }

    private static func expiry(_ v: Any?) -> Double {
        guard let n = (v as? NSNumber)?.doubleValue else {
            if let s = v as? String, let d = ISO8601DateFormatter().date(from: s) {
                return d.timeIntervalSince1970 * 1000
            }
            return .greatestFiniteMagnitude // no expiry field → treat as valid
        }
        return n > 1e12 ? n : n * 1000
    }

    private static func pbkdf2SHA1(password: [UInt8], salt: [UInt8], iterations: Int, keyLen: Int) -> [UInt8] {
        var derived = [UInt8](repeating: 0, count: keyLen)
        let status = password.withUnsafeBufferPointer { pw in
            salt.withUnsafeBufferPointer { sa in
                CCKeyDerivationPBKDF(
                    CCPBKDFAlgorithm(kCCPBKDF2),
                    UnsafeRawPointer(pw.baseAddress)?.assumingMemoryBound(to: Int8.self), pw.count,
                    sa.baseAddress, sa.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), UInt32(iterations),
                    &derived, keyLen)
            }
        }
        return status == kCCSuccess ? derived : []
    }

    private static func decryptSafeStorage(_ b64: String, key: [UInt8]) -> Data? {
        guard let raw = Data(base64Encoded: b64), raw.count > 3 else { return nil }
        let prefix = String(bytes: raw.prefix(3), encoding: .ascii)
        guard prefix == "v10" || prefix == "v11" else { return nil }
        let cipher = [UInt8](raw.dropFirst(3))
        let iv = [UInt8](repeating: 0x20, count: 16)
        var out = [UInt8](repeating: 0, count: cipher.count + kCCBlockSizeAES128)
        var moved = 0
        let st = cipher.withUnsafeBufferPointer { c in
            key.withUnsafeBufferPointer { k in
                iv.withUnsafeBufferPointer { i in
                    CCCrypt(CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES),
                            CCOptions(kCCOptionPKCS7Padding),
                            k.baseAddress, k.count, i.baseAddress,
                            c.baseAddress, c.count, &out, out.count, &moved)
                }
            }
        }
        guard st == kCCSuccess else { return nil }
        return Data(out.prefix(moved))
    }
}
