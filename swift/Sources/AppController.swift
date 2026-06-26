import SwiftUI
import AppKit
import Combine
import ServiceManagement

final class AppController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let store = UsageStore()
    private let cfg = Config.shared
    private var window: NSWindow!
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var alwaysOnTop = true
    private var visible = true

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // no Dock icon — desktop widget
        buildWindow()
        buildStatusItem()
        store.start()
        scheduleTimer()
    }

    // MARK: - Window

    private func buildWindow() {
        let hosting = NSHostingController(rootView: WidgetView(store: store))
        hosting.sizingOptions = [.preferredContentSize]

        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 212, height: 110),
                           styleMask: [.borderless], backing: .buffered, defer: false)
        win.contentViewController = hosting
        win.isOpaque = false
        win.backgroundColor = .clear
        win.hasShadow = false
        win.isMovableByWindowBackground = true
        win.level = alwaysOnTop ? .screenSaver : .normal
        win.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        win.delegate = self
        window = win
        win.orderFrontRegardless()
        DispatchQueue.main.async { [weak self] in self?.restorePosition() }
    }

    private func restorePosition() {
        let d = UserDefaults.standard
        if d.object(forKey: "winX") != nil, d.object(forKey: "winY") != nil {
            window.setFrameOrigin(NSPoint(x: d.double(forKey: "winX"), y: d.double(forKey: "winY")))
            if !NSScreen.screens.contains(where: { $0.visibleFrame.intersects(window.frame) }) { moveToBottomRight() }
        } else { moveToBottomRight() }
    }

    private func moveToBottomRight() {
        guard let screen = NSScreen.main else { return }
        let vf = screen.visibleFrame, size = window.frame.size, margin: CGFloat = 22
        window.setFrameOrigin(NSPoint(x: vf.maxX - size.width - margin, y: vf.minY + margin))
        savePosition()
    }

    private func savePosition() {
        UserDefaults.standard.set(Double(window.frame.origin.x), forKey: "winX")
        UserDefaults.standard.set(Double(window.frame.origin.y), forKey: "winY")
    }

    func windowDidMove(_ notification: Notification) { if visible { savePosition() } }

    private func toggleVisible() {
        visible.toggle()
        if visible { window.orderFrontRegardless() } else { window.orderOut(nil) }
    }

    // MARK: - Status bar (left-click = show/hide, right-click = menu)

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = Brand.statusRing(18)
            button.action = #selector(statusClicked)
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
    }

    @objc private func statusClicked() {
        let event = NSApp.currentEvent
        let isRight = event?.type == .rightMouseUp || (event?.modifierFlags.contains(.control) ?? false)
        if isRight, let button = statusItem.button {
            buildMenu().popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.height + 4), in: button)
        } else {
            toggleVisible()
        }
    }

    private func buildMenu() -> NSMenu {
        cfg.reload()
        let menu = NSMenu()
        menu.addItem(item(visible ? "隐藏" : "显示", #selector(toggleShow)))
        menu.addItem(item("立即刷新", #selector(refreshNow)))
        menu.addItem(.separator())

        let display = NSMenuItem(title: "显示内容", action: nil, keyEquivalent: "")
        let dsub = NSMenu()
        for (mode, label) in [("all", "全部显示"), ("codex", "仅 Codex"), ("claude", "仅 Claude")] {
            let mi = item(label, #selector(setDisplay(_:))); mi.representedObject = mode
            mi.state = cfg.display == mode ? .on : .off; dsub.addItem(mi)
        }
        display.submenu = dsub; menu.addItem(display)

        let size = NSMenuItem(title: "显示大小", action: nil, keyEquivalent: "")
        let ssub = NSMenu()
        for (key, label) in [("small", "小"), ("medium", "中"), ("large", "大")] {
            let mi = item(label, #selector(setSize(_:))); mi.representedObject = key
            mi.state = cfg.size == key ? .on : .off; ssub.addItem(mi)
        }
        size.submenu = ssub; menu.addItem(size)

        let refresh = NSMenuItem(title: "刷新间隔", action: nil, keyEquivalent: "")
        let rsub = NSMenu()
        for secs in [10.0, 20.0, 30.0, 60.0, 0.0] {
            let mi = item(secs > 0 ? "\(Int(secs)) 秒" : "不刷新", #selector(setRefresh(_:)))
            mi.representedObject = secs
            mi.state = abs(cfg.refreshSeconds - secs) < 0.5 ? .on : .off; rsub.addItem(mi)
        }
        refresh.submenu = rsub; menu.addItem(refresh)

        menu.addItem(item("授权读取 Claude 余量…", #selector(authorizeClaude)))
        menu.addItem(.separator())
        menu.addItem(toggle("窗口置顶", #selector(toggleTop), on: alwaysOnTop))
        menu.addItem(toggle("开机启动", #selector(toggleLogin), on: loginEnabled()))
        menu.addItem(.separator())
        menu.addItem(item("打开配置文件", #selector(openConfig)))
        menu.addItem(item("退出", #selector(quit)))
        return menu
    }

    private func item(_ title: String, _ sel: Selector) -> NSMenuItem {
        let mi = NSMenuItem(title: title, action: sel, keyEquivalent: ""); mi.target = self; return mi
    }
    private func toggle(_ title: String, _ sel: Selector, on: Bool) -> NSMenuItem {
        let mi = item(title, sel); mi.state = on ? .on : .off; return mi
    }

    // MARK: - Actions

    @objc private func toggleShow() { toggleVisible() }
    @objc private func refreshNow() { store.refresh() }
    @objc private func setDisplay(_ s: NSMenuItem) { if let m = s.representedObject as? String { cfg.display = m; store.refresh() } }
    @objc private func setSize(_ s: NSMenuItem) {
        if let k = s.representedObject as? String { cfg.size = k; store.size = k }
    }
    @objc private func setRefresh(_ s: NSMenuItem) { if let v = s.representedObject as? Double { cfg.refreshSeconds = v; scheduleTimer(); store.refresh() } }

    @objc private func authorizeClaude() {
        Task { @MainActor in
            let r = await store.authorizeClaude()
            let alert = NSAlert()
            alert.messageText = r.ok ? "已授权读取 Claude 余量" : "未能读取 Claude 钥匙串"
            alert.informativeText = r.ok ? "钥匙串已允许，正在刷新…（以后不会再询问）"
                : "\(r.reason)\n\n再次点击此菜单会弹出系统钥匙串授权框，请务必点「始终允许 / Always Allow」。"
            alert.alertStyle = r.ok ? .informational : .warning
            alert.runModal()
        }
    }

    @objc private func toggleTop() {
        alwaysOnTop.toggle()
        window.level = alwaysOnTop ? .screenSaver : .normal
    }

    @objc private func openConfig() {
        let path = Config.path
        if !FileManager.default.fileExists(atPath: path) { store.refresh() }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    @objc private func quit() { NSApp.terminate(nil) }

    private func loginEnabled() -> Bool {
        if #available(macOS 13.0, *) { return SMAppService.mainApp.status == .enabled }
        return false
    }
    @objc private func toggleLogin() {
        guard #available(macOS 13.0, *) else { return }
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch { NSLog("login toggle failed: \(error.localizedDescription)") }
    }

    // MARK: - Timer

    private func scheduleTimer() {
        timer?.invalidate(); timer = nil
        let secs = cfg.refreshSeconds
        guard secs > 0 else { return }
        timer = Timer.scheduledTimer(withTimeInterval: max(5, secs), repeats: true) { [weak self] _ in
            self?.store.refresh()
        }
    }
}
