import Foundation

/// One usage limit window (5h, 1w, or a per-model scoped cap).
struct UsageWindow: Identifiable {
    let id: String          // "5h" / "1w" / "scoped-<model>"
    let label: String
    let usedPercent: Double? // 0...100, nil when unknown
    let resetsAt: Date?

    var remainingPercent: Double? {
        guard let u = usedPercent else { return nil }
        return max(0, 100 - u)
    }
}

/// A source's snapshot (Codex or Claude).
struct ProviderUsage {
    enum Status { case ok, error, missing, disabled }

    let id: String          // "codex" / "claude"
    let label: String
    var status: Status
    var statusText: String  // short reason; shown in the large tier + on hover
    var planType: String?   // "pro" / "max" …
    var realtime: Bool      // true = live/fresh source, false = cache/log fallback
    var updatedAt: Date?    // when the data was actually measured
    var windows: [UsageWindow]

    static func missing(id: String, label: String, text: String) -> ProviderUsage {
        ProviderUsage(id: id, label: label, status: .missing, statusText: text,
                      planType: nil, realtime: false, updatedAt: nil,
                      windows: [UsageWindow(id: "5h", label: "5h", usedPercent: nil, resetsAt: nil),
                                UsageWindow(id: "1w", label: "1w", usedPercent: nil, resetsAt: nil)])
    }
}

/// Unified freshness colour, identical rules for both sources:
///   ok (green)  = realtime & fresh
///   warn (amber)= non-realtime (log fallback / cache) or aging > 6 min
///   danger (red)= very stale > 30 min, or no data (error / missing)
enum Freshness {
    case ok, warn, danger, muted

    static let graceSec: TimeInterval = 2 * 60
    static let amberSec: TimeInterval = 6 * 60
    static let redSec: TimeInterval = 30 * 60

    static func of(_ p: ProviderUsage) -> Freshness {
        switch p.status {
        case .disabled: return .muted
        case .error, .missing: return .danger
        case .ok: break
        }
        guard let at = p.updatedAt else { return .ok }
        let age = Date().timeIntervalSince(at)
        if age >= redSec { return .danger }
        if age >= amberSec { return .warn }
        if !p.realtime && age >= graceSec { return .warn }
        return .ok
    }
}
