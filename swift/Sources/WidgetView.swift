import SwiftUI

private enum Palette {
    static let text = Color.black.opacity(0.80)
    static let muted = Color.black.opacity(0.42)
    static let line = Color.black.opacity(0.12)
    static let track = Color.black.opacity(0.10)
    static let green = Color(red: 0.208, green: 0.722, blue: 0.447)
    static let amber = Color(red: 0.851, green: 0.604, blue: 0.157)
    static let red = Color(red: 0.851, green: 0.329, blue: 0.298)
    static let gray = Color.black.opacity(0.35)
}

private func freshTint(_ f: Freshness) -> Color {
    switch f { case .ok: return Palette.green; case .warn: return Palette.amber
              case .danger: return Palette.red; case .muted: return Palette.gray }
}
private func numberTint(_ f: Freshness) -> Color {
    switch f { case .warn: return Palette.amber; case .danger: return Palette.red; default: return Palette.text }
}
private func levelTint(_ remaining: Double?) -> Color {
    guard let r = remaining else { return Palette.red }
    if r <= 15 { return Palette.red }; if r <= 35 { return Palette.amber }; return Palette.green
}

private func resetText(_ d: Date?) -> String {
    guard let d else { return "--" }
    let delta = d.timeIntervalSinceNow
    let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN")
    if delta >= 24 * 3600 { f.dateFormat = "M月d日" } else { f.dateFormat = "HH:mm" }
    return f.string(from: d)
}

struct WidgetView: View {
    @ObservedObject var store: UsageStore

    private var isSmall: Bool { store.size == "small" }
    private var isLarge: Bool { store.size == "large" }
    private var panelWidth: CGFloat { store.size == "small" ? 166 : store.size == "large" ? 248 : 212 }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if store.providers.isEmpty {
                Text("无可显示内容").font(.system(size: 10)).foregroundColor(Palette.muted)
            } else {
                ForEach(Array(store.providers.enumerated()), id: \.offset) { idx, p in
                    if idx > 0 {
                        Rectangle().fill(Palette.line).frame(height: 1).padding(.vertical, 1)
                    }
                    row(p)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(width: panelWidth, alignment: .leading)
        .background(VisualEffectView(material: .popover))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Palette.line, lineWidth: 1))
        .environment(\.colorScheme, .light)
        .id(store.tick) // re-evaluate freshness as data ages
    }

    @ViewBuilder private func row(_ p: ProviderUsage) -> some View {
        let f = Freshness.of(p)
        let windows = displayedWindows(p)
        HStack(alignment: .center, spacing: 9) {
            VStack(spacing: 4) {
                if let img = Brand.logo(p.id) {
                    Image(nsImage: img).resizable().aspectRatio(contentMode: .fit)
                        .frame(width: isSmall ? 16 : 22, height: isSmall ? 16 : 22)
                }
                if let plan = p.planType {
                    Text(plan.uppercased()).font(.system(size: 7, weight: .bold))
                        .foregroundColor(freshTint(f))
                        .padding(.horizontal, 3).padding(.vertical, 0.5)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(freshTint(f), lineWidth: 1))
                } else {
                    Circle().fill(freshTint(f)).frame(width: 7, height: 7)
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                ForEach(windows) { w in meter(w, fresh: f) }
                if isLarge, !p.statusText.isEmpty {
                    Text(p.statusText).font(.system(size: 8.5)).foregroundColor(numberTint(f))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder private func meter(_ w: UsageWindow, fresh: Freshness) -> some View {
        let rem = w.remainingPercent
        let pct = rem.map { "\(Int($0.rounded()))%" } ?? "--"
        HStack(spacing: 5) {
            Text(w.label).font(.system(size: 10, weight: .semibold)).foregroundColor(Palette.muted)
                .frame(width: isSmall ? 18 : 18, alignment: .trailing).lineLimit(1)
            if !isSmall {
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.track).frame(height: 6)
                    GeometryReader { geo in
                        Capsule().fill(levelTint(rem))
                            .frame(width: geo.size.width * CGFloat((rem ?? 0) / 100))
                    }.frame(height: 6)
                }.frame(maxWidth: .infinity)
            }
            Text(pct).font(.system(size: 10, weight: .heavy)).foregroundColor(numberTint(fresh))
                .frame(width: 30, alignment: .trailing)
            if !isSmall {
                HStack(spacing: 2) {
                    Text("↻").font(.system(size: 9))
                    Text(resetText(w.resetsAt)).font(.system(size: 10, weight: .semibold))
                }.foregroundColor(numberTint(fresh)).frame(width: 50, alignment: .leading).lineLimit(1)
            }
        }
    }

    private func displayedWindows(_ p: ProviderUsage) -> [UsageWindow] {
        var ws = p.windows.isEmpty
            ? [UsageWindow(id: "5h", label: "5h", usedPercent: nil, resetsAt: nil),
               UsageWindow(id: "1w", label: "1w", usedPercent: nil, resetsAt: nil)]
            : p.windows
        if isSmall { ws = ws.filter { $0.id == "5h" || $0.id == "1w" } }
        return ws
    }
}
