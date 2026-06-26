import Foundation
import Combine

/// Owns the current snapshot and refreshes both sources per the display mode.
/// All @Published writes happen inside `@MainActor` tasks below.
final class UsageStore: ObservableObject {
    @Published var providers: [ProviderUsage] = []
    @Published var size: String = Config.shared.size
    @Published var tick = Date() // bumped periodically so freshness colours age

    private var refreshing = false

    func start() {
        refresh()
        // Re-evaluate freshness colours even when no new data arrives.
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick = Date() }
        }
    }

    func refresh() {
        if refreshing { return }
        refreshing = true
        let cfg = Config.shared
        cfg.reload()
        size = cfg.size
        let wantCodex = cfg.wantCodex
        let wantClaude = cfg.wantClaude
        let codexLive = cfg.codexLive
        let claudeMin = cfg.claudeMinRefresh
        let showScoped = cfg.claudeShowScoped

        Task { @MainActor in
            async let codex: ProviderUsage? = wantCodex ? CodexProvider.shared.usage(live: codexLive) : nil
            async let claude: ProviderUsage? = wantClaude
                ? ClaudeProvider.shared.usage(minRefresh: claudeMin, showScoped: showScoped) : nil
            var out: [ProviderUsage] = []
            if let c = await codex { out.append(c) }
            if let c = await claude { out.append(c) }
            self.providers = out
            self.tick = Date()
            self.refreshing = false
        }
    }

    func authorizeClaude() async -> (ok: Bool, reason: String) {
        let r = await ClaudeProvider.shared.authorizeKeychain()
        if r.ok { refresh() }
        return r
    }
}
