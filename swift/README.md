# 余晖 / Afterglow — 原生 Swift 版

这是 `余晖` 桌面挂件的 **原生 Swift 重写版**，与仓库根目录的 Electron 版功能一致，但：

- 不依赖 Node / Electron / Chromium，编译产物是一个纯原生 `.app`（约几百 KB，启动即开）
- 只用系统自带的命令行工具 `swiftc` 构建（**无需 Xcode、无任何第三方依赖**）
- 内存占用、能耗远低于 Electron 版

两个版本读写**同一个配置文件** `~/.ai-usage-widget/config.json`，可以随意切换，互不影响。

---

## 构建 & 运行

```bash
cd swift
./build.sh
open "build/余晖.app"
```

`build.sh` 会用 `swiftc` 编译 `Sources/*.swift`，打包成 `build/余晖.app`，拷入品牌 logo 与 App 图标，并完成签名。

### 一次性：稳定签名（强烈建议）

Swift 版**直接读取钥匙串**里的 `Claude Safe Storage` 来解密 Claude 令牌。钥匙串的「始终允许」是绑定到 App 代码签名的——若用 ad-hoc 签名，每次重新编译签名都会变，导致反复弹授权框。

先跑一次：

```bash
./setup-signing.sh    # 在本地钥匙串里生成一个固定的自签名身份
./build.sh            # 之后每次构建都会用这个固定身份签名
```

这样在系统钥匙串里点过一次「始终允许 / Always Allow」后，**以后重编译也不会再弹**。

---

## 功能（与 Electron 版对齐）

- **Codex**：优先通过 `codex app-server`（`account/rateLimits/read`，与 `/status` 同源）取**实时账号总额**；取不到时回退读取 `~/.codex/sessions` 日志里的账号池
- **Claude**：读取钥匙串解密 OAuth 令牌（PBKDF2-SHA1 → AES-128-CBC），调用 `/api/oauth/usage`；自动挑选**最新未过期**的 `claude_code` 令牌；内置 429 指数退避、单飞、按尝试节流
- **菜单栏**：左键 = 显示/隐藏挂件，右键 = 菜单
- **菜单**：显示内容（全部 / 仅 Codex / 仅 Claude）、显示大小（小 / 中 / 大）、刷新间隔（10/20/30/60 秒 / 不刷新）、授权读取 Claude 余量、窗口置顶、开机启动、打开配置文件
- **新鲜度配色**：绿 = 实时且新鲜；橙 = 非实时 / 偏旧；红 = 过期或无数据
- 毛玻璃卡片、品牌 SVG logo（`NSImage` 原生加载）、PRO/MAX 徽标外框随新鲜度变色、血条按余量分级着色、可拖动且记忆位置、常驻所有桌面空间

---

## 源码结构

| 文件 | 职责 |
|------|------|
| `Sources/main.swift` | 入口 |
| `Sources/AppController.swift` | 窗口 / 菜单栏 / 菜单 / 定时刷新 / 位置记忆 |
| `Sources/WidgetView.swift` | SwiftUI 卡片（logo + 徽标 + 血条 + 三档大小） |
| `Sources/UsageStore.swift` | 快照状态，按显示模式并发刷新两个数据源 |
| `Sources/ClaudeProvider.swift` | 钥匙串解密 + `/api/oauth/usage` + 429 退避 / 节流 / 单飞 |
| `Sources/CodexProvider.swift` | 驱动 `codex app-server`（stdio JSON-RPC）+ 日志回退 |
| `Sources/Models.swift` | `ProviderUsage` / `UsageWindow` / 新鲜度模型 |
| `Sources/Config.swift` | 读写共享的 `config.json`（保留未知键） |
| `Sources/Brand.swift` | 品牌 logo 加载 + 菜单栏圆环图标 |
| `Sources/VisualEffectView.swift` | 毛玻璃背景 |
| `assets/openai.svg`, `assets/claude.svg` | 品牌 logo |

---

## 与 Electron 版的关系

二者并存于同一仓库：根目录是 Electron 版，`swift/` 是原生版。**不要同时运行两个**（会出现两个挂件 + 两个菜单栏图标）。日常推荐用原生版，更轻量。
