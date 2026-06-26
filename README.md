# 余晖 · Afterglow

英文代号：**Afterglow**。

macOS 常驻桌面小组件，在同一个小窗里**统一显示 Codex 与 Claude 的 5h / 1w 剩余用量**。
以 [Afterglow_Codex](https://github.com/keliihall/Afterglow_Codex) 的展示形式为主体，融合了
[Afterglow_Claude](https://github.com/keliihall/Afterglow_Claude) 的真实余量数据源。

- 默认停靠在桌面右下角，半透明毛玻璃、可拖动（位置记忆、离屏自动归位）、默认置顶、跨所有桌面空间显示。
- **三档大小**（小 / 中 / 大）、**显示内容**切换（全部 / 仅 Codex / 仅 Claude）、**自定义刷新间隔**。
- **新鲜度配色**：实时且新鲜 = 绿，非实时 / 开始偏旧 = 橙，很旧 / 无数据 = 红——数字和状态点都会随之变色，一眼看出数值是否当前。
- 菜单栏图标：**左键显示 / 隐藏挂件，右键打开设置菜单**。无 Dock 图标。

## 数据来源

两个数据源都是**官方真实余量**，不是 token 估算：

| 来源 | 取数方式 |
|------|----------|
| **Codex** | 首选驱动 `codex app-server` 的 `account/rateLimits/read`（与 Codex `/status` 同款的**实时账号总额**，子模型期间也准确）；不可用时回落到本机 `~/.codex/sessions/**/*.jsonl` 的会话日志（账号池 `limit_id="codex"`，`primary`=5h、`secondary`=1w）。回落值是**非实时**的，会按新鲜度标橙/红。 |
| **Claude** | 复用 Claude 桌面应用的 OAuth 令牌调官方接口 `GET /api/oauth/usage`，与 Claude「Plan usage」面板完全一致（`session` = 5h，`weekly_all` = 1w，`weekly_scoped` = 单模型）。 |

### Claude 取数原理（移植自 Afterglow_Claude 的 Swift 实现）

1. 读取 `~/Library/Application Support/Claude/config.json` 里的 `oauth:tokenCacheV2`
   （Electron `safeStorage` 加密的 OAuth 访问令牌）。
2. 用 macOS 钥匙串里的 **`Claude Safe Storage`** 密钥解密
   （AES-128-CBC，PBKDF2-SHA1 / `saltysalt` / 1003 轮，与 Chromium safeStorage 同方案）。
3. 带令牌调用 `/api/oauth/usage`，解析 `limits` 数组。

> **前提**：本机装有并登录了 Claude 桌面应用（它负责保持令牌有效）。
> **首次刷新会弹一次钥匙串授权框**（读取 `Claude Safe Storage`），点「始终允许 / Always Allow」后不再询问。
> 钥匙串密钥每次启动只读一次并在内存缓存，后续刷新只重读 config.json，不会反复弹窗。

> **限流与缓存**：`/api/oauth/usage` 走 Cloudflare、有速率限制，且与 Claude 桌面端 / Claude Code
> 共用同一账号配额。为此插件会：把 Claude 网络请求节流到最快每 `minRefreshSeconds`（默认 90 秒）
> 一次、且锚定「上次尝试」（无论成败都按此间隔）；遇到 **429 时指数退避**（约 60s→2m→4m…封顶 15min，
> 带抖动，尊重 `Retry-After`），退避结束并成功后清零；把启动 / 多显示器 / 渲染层的并发请求**合并为一次**
> （单飞）。期间始终复用上次成功的数据并按**新鲜度**标橙 / 红（见下文「配色含义」），而不是报错清空。

### 换电脑后 Claude 不显示 / 排错

Claude 这一行不再用模糊的「加载中…」掩盖错误——它会**直接显示具体原因**（大号档位整行可见，其它档位 hover 可见，状态点变红）：

| 显示 | 原因 | 解决 |
|------|------|------|
| `未检测到 Claude 桌面端（请先安装并登录）` | 本机没有 `~/Library/Application Support/Claude/config.json` | 安装并登录 Claude 桌面应用 |
| `未检测到 Claude 密钥…` | 钥匙串里没有 `Claude Safe Storage` | 打开一次 Claude 桌面应用让它生成密钥 |
| `钥匙串未授权（…）` | 首次读取 `Claude Safe Storage` 的授权框被**拒绝/忽略/只点了一次「允许」** | 点托盘菜单 **「授权读取 Claude 余量…」** 重新弹出授权框，务必选 **始终允许 / Always Allow**（之后永久生效，重装也不再问） |
| `登录已过期，请在 Claude 里重新登录` | 令牌失效且未自动续期 | 在 Claude 里发条消息或退出重登以续期，再刷新挂件 |
| `请求过于频繁(429)` | 触发限流 | 自动退避，稍候即恢复 |

> **关于「始终允许」**：挂件通过系统 `security` 读取 `Claude Safe Storage`。授权框上点
> **「允许」只生效一次**（下次又问、还可能被漏点/拒绝导致 Claude 读不到），必须点
> **「始终允许 / Always Allow」**——它把授权永久记在 `security` 上（重装挂件、重新打包都不再问）。
> 如果第一次没点对，**不用重装**：托盘菜单点「授权读取 Claude 余量…」会再次弹框，这次选「始终允许」即可。

在新电脑上也可用这条命令自查 / 手动授权（终端里运行，弹框选「始终允许」后挂件即可读取）：

```bash
ls "$HOME/Library/Application Support/Claude/config.json"   # 是否安装并登录了 Claude
security find-generic-password -s "Claude Safe Storage" -w  # 钥匙串能否读取（弹框 → 始终允许）
```

## 运行

```bash
npm install
npm start
```

菜单栏出现“余晖”图标；小窗可拖动，默认置顶。

## 设置

**菜单栏图标**：**左键**显示 / 隐藏挂件；**右键**打开设置菜单。

**卡片顶部**显示当前刷新间隔（如 `↻ 20s`），**点击它循环切换** `10s → 30s → 60s → off`；选 `off` 时停止自动刷新（显示 `⏸ off`），可随时点回来恢复。

**右键菜单**里可以：

- **显示内容**：全部显示 / 仅 Codex / 仅 Claude（切到「仅 Codex」时完全不触碰 Claude 令牌，也不会弹钥匙串）。
- **显示大小**：小 / 中 / 大（小档最紧凑、只留关键数字；大档带进度条 + 状态详情行）。
- **刷新间隔**：10 / 20 / 30 / 60 秒 / 不刷新。
- **授权读取 Claude 余量…**：重新弹出钥匙串授权框（首次没点「始终允许」时用它补救，见上文）。
- 显示 / 隐藏、立即刷新、窗口置顶、开机启动、打开配置文件、退出。

**配色含义**：每个数据源左侧是品牌 logo（Codex = OpenAI，Claude = Claude）；下方 `PRO`/`MAX` 徽标的**外框颜色**与**百分比数字**一起表达**新鲜度**：

- 🟢 **绿**：实时且新鲜（Codex 走 app-server、Claude 刚拉取成功）。
- 🟠 **橙**：非实时或开始偏旧——Codex 回落到会话日志、Claude 用缓存、或数据 > ~6 分钟；hover 看具体原因。
- 🔴 **红**：很旧（> ~30 分钟）或拿不到数据（未登录 / 钥匙串未授权 / 限流且无缓存等）。

（单次抖动有约 2 分钟宽限，不会闪色；没有订阅徽标时回退为一个同色状态圆点。）
进度条颜色另按**剩余量**走：绿（充足）→ 黄（≤35%）→ 红（≤15%）。
菜单栏图标是一枚随浅色 / 深色菜单栏自动适配的「余晖光晕」圆环图标（与 App 图标的发光圆盘呼应）。

## 快速检查采集结果

```bash
npm run usage:once
```

## 配置

首次运行会创建 `~/.ai-usage-widget/config.json`：

```json
{
  "refreshSeconds": 20,
  "display": "all",
  "size": "medium",
  "providers": {
    "codex": {
      "enabled": true,
      "live": true,
      "sessionDir": "~/.codex/sessions",
      "maxFiles": 80,
      "maxAgeDays": 8
    },
    "claude": {
      "enabled": true,
      "showScoped": true,
      "minRefreshSeconds": 90
    }
  }
}
```

字段说明：

- `refreshSeconds`：整体刷新间隔（秒，最小 5；`0` = 不刷新）。卡片顶部的 `↻` 和菜单「刷新间隔」改的就是它。
- `display`：`"all"` / `"codex"` / `"claude"`，对应菜单「显示内容」。
- `size`：`"small"` / `"medium"` / `"large"`，对应菜单「显示大小」。
- `providers.<name>.enabled`：彻底关闭某个数据源（即使在「全部显示」下也不显示）。
- `providers.codex.live`：是否首选 `codex app-server` 实时账号用量（默认 `true`）；设 `false` 则只读会话日志。
- `providers.claude.showScoped`：是否在占用后显示单模型周限额（如 `Sonnet`）。
- `providers.claude.minRefreshSeconds`：Claude 网络请求的最小间隔（默认 90 秒；Codex 仍按 `refreshSeconds` 快刷新）。429 时还会在此基础上指数退避。

## 打包成 App / 安装

### 最简单：一条命令构建并安装到「应用程序」

```bash
npm run install:mac
```

它会自动 `npm install` → 用 electron-builder 打包（arm64、ad-hoc 重签名）→
**校验代码签名封口有效** → 安装到 `/Applications/余晖.app` 并启动。
产物 `余晖-0.1.0-arm64.dmg` / `.zip` 同时生成在 `dist/`。

> 想在「访达」里双击运行安装，可执行一次：
> `chmod +x scripts/install-mac.sh && cp scripts/install-mac.sh 安装余晖.command`，以后双击 `安装余晖.command` 即可。

### 只打包不安装

```bash
npm run dist:mac    # 生成 dist/余晖-*.dmg + .zip，并校验签名封口
npm run pack:mac    # 只生成未压缩的 .app（dist/mac-arm64/）
```

### 分发给别人（DMG 拖拽安装）

把 `dist/余晖-0.1.0-arm64.dmg` 发给对方，对方：

1. 双击 `余晖-0.1.0-arm64.dmg`。
2. 把 **余晖** 图标拖到旁边的 **Applications** 文件夹。
3. 推出磁盘镜像。
4. 打开「应用程序」，**右键** 余晖 →「打开」（第一次别直接双击）。弹窗里点「打开」。
   *(macOS 15+ 若没有「打开」按钮：系统设置 → 隐私与安全性 → 拉到底「仍要打开」。)*
5. App 没有 Dock 图标——到屏幕右上角**菜单栏**找它的图标。**左键**显示 / 隐藏挂件，**右键**打开设置菜单。
6. 首次显示 Claude 数据时会弹一次钥匙串：
   **「security 想要使用钥匙串里的 "Claude Safe Storage"」**——输入开机密码并点
   **「始终允许 / Always Allow」**（不是「允许」，更不要「拒绝」）。只会问这一次。

### 为什么没有 Apple 开发者签名

本项目是本地/小范围分发，未做 Apple 公证（notarization）。因此：

- **你自己机器上**本地构建安装：不带隔离属性，直接打开，无 Gatekeeper 弹窗。
- **别人下载/AirDrop 收到**：会被标记隔离，需第一次「右键→打开」放行一次（仅一次）。这是未公证 App 的固有行为，只有花钱买 Apple Developer ID 公证才能免除。
- **关于钥匙串**：余晖 是通过子进程调用系统自带的 `/usr/bin/security` 来读取密钥的，所以「始终允许」是授权给那个稳定的系统程序，**重新编译/重装余晖都不会再次弹窗**。

### 前提条件

- Apple Silicon（arm64）。如需给 Intel Mac 用户，把 `package.json` 里 `mac.target` 的 `arch` 改成 `universal` 重新构建。
- 要显示 Claude 数据，对方机器需装有并登录 **Claude 桌面应用**；要显示 Codex，需要本机有 `~/.codex/sessions`。缺失时对应面板显示「未找到…」，不会崩溃。

### 换图标

两个图标是成套的「余晖光晕」主题：

- **App 图标** `assets/icon.icns`（深暮色方角 + 暖色发光圆盘），由 `assets/icon.svg` 生成。改了 SVG 后重建：

  ```bash
  npm run icon       # 用系统自带 qlmanage/sips/iconutil 重新生成 icon.icns
  ```

- **菜单栏图标** 是一枚自适应明暗的圆环（光晕的轮廓），由 `scripts/make-tray-icon.js` 用纯 Node
  栅格化为透明 PNG，并以 base64 内嵌在 `src/main.js` 的 `createTrayIcon()`。改了它的几何参数后：

  ```bash
  node scripts/make-tray-icon.js          # 打印新的 base64，粘进 main.js 的 TRAY_ICON
  node scripts/make-tray-icon.js out.png  # 另存一张 PNG 方便预览
  ```
