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
    private var panelWidth: CGFloat { store.size == "small" ? 168 : store.size == "large" ? 348 : 252 }
    private var rowSpacing: CGFloat { isLarge ? 12 : 9 }
    private var logoSize: CGFloat { isSmall ? 18 : isLarge ? 34 : 22 }
    private var panelCorner: CGFloat { isLarge ? 20 : 16 }
    private var panelLeadingInset: CGFloat { isSmall ? 8 : isLarge ? 16 : 14 }
    private var panelTrailingInset: CGFloat { isSmall ? 8 : isLarge ? 16 : 6 }

    var body: some View {
        VStack(alignment: .leading, spacing: isLarge ? 11 : 7) {
            if store.providers.isEmpty {
                Text("无可显示内容").font(.system(size: isLarge ? 14 : 10)).foregroundColor(Palette.muted)
            } else {
                ForEach(Array(store.providers.enumerated()), id: \.offset) { idx, p in
                    if idx > 0 {
                        Rectangle().fill(Palette.line).frame(height: 1).padding(.vertical, isLarge ? 4 : 1)
                    }
                    row(p)
                }
            }
        }
        .padding(.leading, panelLeadingInset)
        .padding(.trailing, panelTrailingInset)
        .padding(.vertical, isLarge ? 14 : 8)
        .frame(width: panelWidth, alignment: .leading)
        .background(panelMaterial(corner: panelCorner))
        .clipShape(RoundedRectangle(cornerRadius: panelCorner, style: .continuous))
        .overlay(panelGlass(corner: panelCorner))
        .environment(\.colorScheme, .light)
        .id(store.tick) // re-evaluate freshness as data ages
    }

    @ViewBuilder private func panelMaterial(corner: CGFloat) -> some View {
        ZStack {
            VisualEffectView(material: .popover)
            RoundedRectangle(cornerRadius: corner, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(isLarge ? 0.24 : 0.18),
                            Color.white.opacity(0.07),
                            Color.white.opacity(0.02)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
        }
    }

    @ViewBuilder private func panelGlass(corner: CGFloat) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: corner, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(isLarge ? 0.28 : 0.20),
                            Color.white.opacity(0.06),
                            Color.clear
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .blendMode(.screen)

            RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(isLarge ? 0.34 : 0.30), lineWidth: 0.7)

            RoundedRectangle(cornerRadius: max(corner - 1, 0), style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(isLarge ? 0.26 : 0.20),
                            Color.white.opacity(0.04),
                            Color.clear
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 1
                )
                .padding(1)

            VStack(spacing: 0) {
                RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(isLarge ? 0.18 : 0.12),
                                Color.clear
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .frame(height: isLarge ? 58 : 36)
                Spacer(minLength: 0)
            }
            .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder private func row(_ p: ProviderUsage) -> some View {
        if isSmall {
            smallRow(p)
        } else if isLarge {
            largeRow(p)
        } else {
            regularRow(p)
        }
    }

    @ViewBuilder private func smallRow(_ p: ProviderUsage) -> some View {
        let f = Freshness.of(p)
        let windows = displayedWindows(p)
        HStack(alignment: .center, spacing: 7) {
            if let img = Brand.logo(p.id) {
                Image(nsImage: img).resizable().aspectRatio(contentMode: .fit)
                    .frame(width: logoSize, height: logoSize)
            }
            HStack(spacing: 7) {
                ForEach(windows) { w in smallMeter(w, fresh: f) }
            }
        }
        .padding(.leading, 3)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func largeRow(_ p: ProviderUsage) -> some View {
        let f = Freshness.of(p)
        let windows = displayedWindows(p)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 9) {
                if let img = Brand.logo(p.id) {
                    Image(nsImage: img).resizable().aspectRatio(contentMode: .fit)
                        .frame(width: 28, height: 28)
                }
                Text(p.label)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(Palette.text)
                if let plan = p.planType {
                    Text(plan.uppercased())
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(freshTint(f))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1.5)
                        .background(Capsule().fill(Color.white.opacity(0.45)))
                        .overlay(Capsule().stroke(freshTint(f), lineWidth: 1))
                } else {
                    Circle().fill(freshTint(f)).frame(width: 8, height: 8)
                }
                Spacer(minLength: 8)
                if !p.statusText.isEmpty {
                    Text(p.statusText)
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundColor(numberTint(f))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                }
            }

            VStack(alignment: .leading, spacing: 9) {
                ForEach(windows) { w in largeMetric(w, fresh: f) }
            }
        }
    }

    @ViewBuilder private func largeMetric(_ w: UsageWindow, fresh: Freshness) -> some View {
        let rem = w.remainingPercent
        let pct = rem.map { "\(Int($0.rounded()))%" } ?? "--"
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(w.label)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(Palette.muted)
                    .frame(width: 62, alignment: .leading)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(pct)
                    .font(.system(size: 21, weight: .heavy))
                    .foregroundColor(numberTint(fresh))
                    .frame(width: 58, alignment: .trailing)
                    .lineLimit(1)
                HStack(spacing: 3) {
                    Text("↻").font(.system(size: 11, weight: .medium))
                    Text(resetText(w.resetsAt)).font(.system(size: 12, weight: .semibold))
                }
                .foregroundColor(numberTint(fresh))
                .frame(width: 78, alignment: .leading)
                .lineLimit(1)
            }
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.track).frame(height: 9)
                GeometryReader { geo in
                    Capsule().fill(levelTint(rem))
                        .frame(width: geo.size.width * CGFloat((rem ?? 0) / 100))
                }
                .frame(height: 9)
            }
        }
    }

    @ViewBuilder private func regularRow(_ p: ProviderUsage) -> some View {
        let f = Freshness.of(p)
        let windows = displayedWindows(p)
        HStack(alignment: .center, spacing: rowSpacing) {
            brandColumn(p, fresh: f, rowCount: windows.count)
            VStack(alignment: .leading, spacing: isLarge ? 7 : 3) {
                ForEach(windows) { w in meter(w, fresh: f) }
                if isLarge, !p.statusText.isEmpty {
                    Text(p.statusText).font(.system(size: 12, weight: .medium)).foregroundColor(numberTint(f))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder private func brandColumn(_ p: ProviderUsage, fresh f: Freshness, rowCount: Int) -> some View {
        if isLarge {
            ZStack(alignment: .topTrailing) {
                if let img = Brand.logo(p.id) {
                    Image(nsImage: img).resizable().aspectRatio(contentMode: .fit)
                        .frame(width: logoSize, height: logoSize)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .padding(.top, 1)
                }
                if let plan = p.planType {
                    Text(plan.uppercased())
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(freshTint(f))
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.white.opacity(0.42)))
                        .overlay(Capsule().stroke(freshTint(f), lineWidth: 1))
                        .offset(x: 2, y: -4)
                } else {
                    Circle().fill(freshTint(f)).frame(width: 9, height: 9).offset(x: -1, y: -1)
                }
            }
            .frame(width: 52, height: max(42, CGFloat(rowCount) * 31), alignment: .topLeading)
        } else {
            VStack(spacing: 4) {
                if let img = Brand.logo(p.id) {
                    Image(nsImage: img).resizable().aspectRatio(contentMode: .fit)
                        .frame(width: logoSize, height: logoSize)
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
            .frame(width: 28)
        }
    }

    @ViewBuilder private func smallMeter(_ w: UsageWindow, fresh: Freshness) -> some View {
        let rem = w.remainingPercent
        let pct = rem.map { "\(Int($0.rounded()))%" } ?? "--"
        HStack(spacing: 3) {
            Text(w.label)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(Palette.muted)
                .lineLimit(1)
            Text(pct)
                .font(.system(size: 12, weight: .heavy))
                .foregroundColor(numberTint(fresh))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(width: 52, alignment: .leading)
    }

    @ViewBuilder private func meter(_ w: UsageWindow, fresh: Freshness) -> some View {
        let rem = w.remainingPercent
        let pct = rem.map { "\(Int($0.rounded()))%" } ?? "--"
        HStack(spacing: isLarge ? 8 : 5) {
            Text(w.label)
                .font(.system(size: isLarge ? 14 : 10, weight: .semibold))
                .foregroundColor(Palette.muted)
                .frame(width: isLarge ? scopedLabelWidth(w) : 30, alignment: .trailing)
                .lineLimit(1)
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.track).frame(height: isLarge ? 10 : 6)
                GeometryReader { geo in
                    Capsule().fill(levelTint(rem))
                        .frame(width: geo.size.width * CGFloat((rem ?? 0) / 100))
                }.frame(height: isLarge ? 10 : 6)
            }
            .frame(width: isLarge ? 132 : nil)
            .frame(maxWidth: isLarge ? nil : .infinity)
            Text(pct)
                .font(.system(size: isLarge ? 18 : 10, weight: .heavy))
                .foregroundColor(numberTint(fresh))
                .frame(width: isLarge ? 48 : 30, alignment: .trailing)
                .lineLimit(1)
            HStack(spacing: isLarge ? 3 : 2) {
                Text("↻").font(.system(size: isLarge ? 12 : 9))
                Text(resetText(w.resetsAt)).font(.system(size: isLarge ? 13 : 10, weight: .semibold))
            }
            .foregroundColor(numberTint(fresh))
            .frame(width: isLarge ? 92 : 74, alignment: .leading)
            .lineLimit(1)
        }
    }

    private func scopedLabelWidth(_ w: UsageWindow) -> CGFloat {
        60
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
