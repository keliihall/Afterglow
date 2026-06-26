# 余晖 / Afterglow Swift

这是 `余晖` 桌面挂件的原生 Swift 版。它和仓库根目录的 Electron 版读取同一个配置文件 `~/.ai-usage-widget/config.json`，但不依赖 Node、Electron 或 Chromium，启动更快，占用更低。

当前 Swift 版：`v0.3.0`

## 下载

前往 Swift 版 release 下载：

https://github.com/keliihall/Afterglow/releases/tag/v0.3.0

推荐下载 `Afterglow-Swift-v0.3.0-arm64.dmg`，也可以下载 `Afterglow-Swift-v0.3.0-arm64.zip`。

要求：

- macOS 13 或更新版本
- Apple Silicon Mac，当前 release 为 `arm64`

说明：

- Swift 版是菜单栏常驻桌面挂件，启动后不会出现在 Dock。
- 不要同时运行 Electron 版和 Swift 版，否则会出现两个挂件和两个菜单栏图标。
- 当前应用未做 Apple notarization。如果 macOS 提示无法打开，可以右键应用选择“打开”，或在终端执行 `xattr -dr com.apple.quarantine /Applications/余晖.app`。

## 功能

- Codex：优先通过 `codex app-server` 读取实时账号总额，取不到时回退读取 `~/.codex/sessions` 日志里的账号池。
- Claude：读取钥匙串里的 `Claude Safe Storage`，解密 OAuth 令牌后调用 `/api/oauth/usage`，自动挑选最新未过期的 `claude_code` 令牌。
- 菜单栏：左键显示/隐藏挂件，右键打开菜单。
- 菜单：显示内容、显示大小、刷新间隔、授权读取 Claude 余量、窗口置顶、开机启动、打开配置文件、退出。
- 三档大小：小档只显示 logo 与 `5h/1w`；中档保持紧凑；大档展示更完整的账号、模型和重置信息。
- 视觉：原生毛玻璃、内部高光层次、品牌 logo、PRO/MAX 徽标、按余量分级的血条颜色。
- 窗口：可拖动、记忆位置、可置顶、常驻所有桌面空间。

## 本地构建

Swift 版只使用系统自带的 Command Line Tools 构建，无需 Xcode 工程或第三方依赖。

```bash
cd swift
./build.sh
open "build/余晖.app"
```

`build.sh` 会执行以下操作：

- 使用 `swiftc` 编译 `Sources/*.swift`
- 打包为 `build/余晖.app`
- 拷贝品牌 logo 与 App 图标
- 写入 `Info.plist`
- 使用稳定签名身份签名；如果本机没有签名身份，则回退为 ad-hoc 签名

## 稳定签名

Swift 版需要读取钥匙串中的 Claude 令牌。macOS 钥匙串的“始终允许 / Always Allow”会绑定到应用签名。如果每次构建都使用临时签名，系统可能反复弹授权框。

首次本机构建前建议执行：

```bash
cd swift
./setup-signing.sh
./build.sh
```

之后同一台机器上重编译，签名身份会保持稳定，钥匙串授权也更稳定。

## 源码结构

| 文件 | 职责 |
|------|------|
| `Sources/main.swift` | 入口 |
| `Sources/AppController.swift` | 窗口、菜单栏、菜单、定时刷新、位置记忆 |
| `Sources/WidgetView.swift` | SwiftUI 挂件 UI |
| `Sources/UsageStore.swift` | 快照状态和并发刷新 |
| `Sources/ClaudeProvider.swift` | 钥匙串解密、Claude usage API、429 退避和节流 |
| `Sources/CodexProvider.swift` | `codex app-server` JSON-RPC 和日志回退 |
| `Sources/Models.swift` | `ProviderUsage`、`UsageWindow` 和新鲜度模型 |
| `Sources/Config.swift` | 共享配置读写 |
| `Sources/Brand.swift` | 品牌 logo 和菜单栏图标 |
| `Sources/VisualEffectView.swift` | 原生毛玻璃背景 |
| `assets/openai.svg`, `assets/claude.svg` | 品牌 logo |

## 发版约定

仓库根目录仍保留 Electron 版 release。Swift 版从 `v0.3.0` 开始使用独立版本线：

- tag：`v0.3.0`
- release 标题：`Afterglow Swift v0.3.0`
- 产物：`Afterglow-Swift-v0.3.0-arm64.dmg`、`Afterglow-Swift-v0.3.0-arm64.zip`

构建发布包时：

```bash
cd swift
./build.sh
```

然后将 `build/余晖.app` 打包为 DMG/ZIP 并上传到对应 GitHub Release。
