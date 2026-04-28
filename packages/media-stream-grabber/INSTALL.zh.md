# 安装教程 — Media Stream Grabber

[English](./INSTALL.md)

面向终端用户的完整安装说明。五分钟从零完成安装。

---

## 1. 支持的浏览器

任何支持 Manifest V3 的 Chromium 内核浏览器:

| 浏览器             | 状态       | 备注                                         |
| ------------------ | ---------- | -------------------------------------------- |
| Google Chrome ≥ 88 | ✅ 已测试  | 推荐                                         |
| Microsoft Edge     | ✅ 已测试  | 流程一致,扩展页是 `edge://extensions`        |
| Brave              | ✅ 可用    | `brave://extensions`                         |
| Vivaldi            | ✅ 可用    | `vivaldi://extensions`                       |
| Opera              | ✅ 可用    | `opera://extensions`                         |
| Arc                | ✅ 可用    | 同 Chrome                                    |
| Firefox            | ❌ 暂不支持 | 扩展格式不同(MV3 + WebExt API)            |

下文统一写 `chrome://extensions`,你按浏览器替换前缀即可。

---

## 2. 下载安装包

直接用「最新版别名链接」抓最新稳定版,不用关心版本号:

> https://github.com/stareing/tasty-rice-plugins/releases/latest/download/media-stream-grabber.zip

会拿到:

- 单个 `.zip` 文件,约 200 KB
- 文件名 `media-stream-grabber.zip`

**为什么不是一键安装的 `.crx`?** Chrome 出于安全考虑,在消费版上拦截了
所有非 Web Store 来源的 `.crx` 安装。「加载已解压的扩展程序」是自托管
扩展唯一被官方支持的路径。

---

## 3. 解压

挑一个不会被误删的目录 — 扩展会从这个目录持续运行,**不要放在
`~/Downloads/`** 里。

| 系统    | 推荐位置                                          |
| ------- | ------------------------------------------------- |
| Windows | `C:\Tools\MediaStreamGrabber\`                    |
| macOS   | `~/Applications/MediaStreamGrabber/`              |
| Linux   | `~/.local/share/media-stream-grabber/`            |

**Windows:** 右键 ZIP → **全部解压…** → 选目标目录。
不要用「双击 ZIP 进入预览模式」,Chrome 加载不了 ZIP 内部的虚拟路径。

**macOS:** 双击 ZIP,Finder 会就地解压出一个同名文件夹。

**Linux:** `unzip media-stream-grabber.zip -d ~/.local/share/media-stream-grabber/`

解压完目录里至少应能看到:

```
manifest.json
service-worker-loader.js
assets/
icons/
src/
```

如果只看到另一个 `.zip` — 那是没解压,只是预览了。

---

## 4. 加载已解压的扩展程序

1. 浏览器地址栏打开 `chrome://extensions`。
2. 右上角打开 **「开发者模式」** 开关,页面顶部会展开三个新按钮。
3. 点 **「加载已解压的扩展程序」**。
4. 文件选择框中**选择第 3 步那个文件夹**(里面要有 `manifest.json`)。
   macOS 单击文件夹后按 "Select",Windows 上点 "选择文件夹"。
5. 扩展卡片出现,显示 **MSG** 图标和版本号。

工具栏会出现 **MSG** 小图标。如果被收起来了,点扩展拼图图标把
Media Stream Grabber 固定到工具栏。

---

## 5. 首次使用 — 快速上手

1. 打开任意有视频的网页 — YouTube、Twitch、纪录片站,任何走 HLS / DASH /
   直链播放的页面。
2. 开始播放视频。工具栏 MSG 图标会显示一个小角标,数字是已嗅探到的流数量。
3. 点 MSG 图标,弹窗会列出所有嗅探到的流:
   - 编码 / 格式猜测(`HLS .m3u8`、`MP4`、`audio/mp3` 等)
   - 分辨率(若可识别)
   - 源 URL
4. 每条流可:
   - **复制 URL** — 仅链接,方便丢给 `yt-dlp` 或 `curl`
   - **下载** — 直链类直接经 Chrome 下载管理器立即下载;HLS 类会启动
     offscreen 流水线:解析 playlist → 并行拉分片 → AES-128 解密 →
     ffmpeg 重封装 → 单文件 MP4

在 `<video>` / `<audio>` / `<img>` / 嗅探到的流 URL 上**右键**也可以,
菜单里有 **「用 Media Stream Grabber 下载」**。

---

## 6. 哪些能抓 / 哪些不能

| 来源                                    | 状态                                          |
| --------------------------------------- | --------------------------------------------- |
| 直链 `.mp4` / `.m4v` / `.webm` 等       | ✅ 走 Chrome 原生下载                         |
| 直链音频(`.mp3` / `.m4a` 等)         | ✅ 同上                                       |
| HLS `.m3u8`(master + media)           | ✅ 解析 → 拉分片 → AES-128 → ffmpeg → MP4    |
| HLS 字节范围分片                        | ✅ 用 Range 头                                |
| HLS 滚动密钥                            | ⚠️ 仅支持单密钥(v1 限制)                    |
| DASH `.mpd`                             | 🚧 已嗅探,但暂未实现下载(roadmap)          |
| MSE / `blob:` URL                       | ❌ 不在范围内,需要页面注入才能抓             |
| DRM 加密(Widevine / FairPlay)        | ❌ 永不支持                                   |

如果某个站只用 MSE 而不暴露 playlist URL,弹窗会空着,这是正常的。

---

## 7. 升级到新版本

新版本发布时,**MSG 图标不会自动更新** — 因为你用的是 unpacked 不是
Web Store。升级流程:

1. 从同一个 URL 下载新的 `media-stream-grabber.zip`。
2. **覆盖解压**到老目录(覆盖所有同名文件)。Windows 上选「替换目标位置中的文件」。
3. 打开 `chrome://extensions` → 找到 Media Stream Grabber → 点卡片上的
   小刷新图标。

完成。浏览器状态、设置、扩展 ID 都不变。

---

## 8. 卸载

1. 打开 `chrome://extensions`。
2. 找到 Media Stream Grabber → 点 **「移除」**。
3. (可选)删除磁盘上的解压目录。

扩展只在 `chrome.storage.session` 中保存数据,卸载时 Chrome 自动清理。
不写注册表,不写系统目录。

---

## 9. 常见问题排查

### 加载后扩展卡片报红

最常见的几种:

- **选错文件夹了。** 要选**包含 `manifest.json` 的那个文件夹**,不是它的
  上一级。重新选一次。
- **目录只读。** macOS 偶尔会把解压目录挂成 DMG 风格的只读卷,把它移到
  `~/Applications/` 再加载。
- **企业策略 / 杀软拦截 unpacked 扩展。** 查 `chrome://policy`,看
  `ExtensionInstallBlocklist` 有没有被设。要么找管理员要权限,要么用个人 profile。

### MSG 图标没有角标 / 弹窗是空的

- 页面还没发媒体请求 — 先播视频。
- 一些 SPA 站点要等用户交互才请求 manifest。点播放,等 1~2 秒再开弹窗。
- 进 `chrome://extensions` → 找到扩展 → Service worker → **Inspect**。
  如果 SW 一片 500 错误,扩展可能崩了,reload 一下。

### HLS 下载到一半 "ffmpeg load failed"

首次合并 HLS 时,`ffmpeg.wasm` 会从 `unpkg.com` 拉(约 30 MB,会缓存)。
排查:

- **首次合并时无网络。** 联网开一次让它缓存进 SW,以后离线可用。
- **公司代理屏蔽 unpkg。** 加白名单,或等 roadmap 里「内置 ffmpeg-core」
  的版本(已规划)。

### 下载下来文件名很怪

Chrome 根据 `Content-Disposition` 和 URL 路径决定文件名。下载后到下载
目录手动重命名 — 弹窗里目前没有重命名 UI。已规划进 v0.2。

### 右键菜单看不到「用 Media Stream Grabber 下载」

- 需要 `contextMenus`、`notifications` 权限,这些是 v0.1.0 才加的。如果
  你装的是更早的内部版,升级到 v0.1.0 即可。
- 有些站的播放器浮层会吞掉右键事件。在视频底部边缘右键试试,或者直接用
  弹窗。

### 访问 `/apps/media-stream-grabber` 显示 Page Not Found

那是博客详情页,不是扩展。如果 `https://tastyrice.org/apps/media-stream-grabber`
返回 404,通常是博客在重新部署中,30 秒后再刷新。

---

## 10. 权限说明

扩展声明了 `host_permissions: <all_urls>` 和 `webRequest`,听起来挺吓人,
逐项解释一下:

| 权限                            | 用途                                                            |
| ------------------------------- | --------------------------------------------------------------- |
| `webRequest`                    | 观察网络响应以识别媒体 URL,**只读**                            |
| `host_permissions: <all_urls>`  | `webRequest` 要看到响应必须配套这个                             |
| `downloads`                     | 保存合并后的 MP4 / 直链媒体到下载目录                           |
| `offscreen`                     | 跑 `ffmpeg.wasm`(service worker 跑 wasm 不稳定)              |
| `storage`                       | 仅 `chrome.storage.session`,存每个 tab 的流状态,不同步        |
| `tabs` / `activeTab`            | 弹窗 UI 需要读当前 tab 的 id 和 title                           |
| `scripting`                     | 预留给未来的页面注入辅助(比如 `<video>` 元素探测)             |
| `contextMenus`                  | 右键「用 Media Stream Grabber 下载」                            |
| `notifications`                 | 下载开始 / 失败 / blob URL 降级时弹个 toast                     |

**无埋点。无远程日志。无登录。无遥测。** 扩展自己唯一的对外网络请求是
首次合并 HLS 时去 unpkg 拉 `ffmpeg-core`。其余流量要么是你授权的(下载
你点的那条流的分片),要么是本地的(在浏览器里跑 ffmpeg)。

不放心可以在弹窗上右键 → 检查,看 Network 面板自查。

---

## 11. 自己从源码构建(开发者)

不想信任预构建包,要自己 build:

```bash
git clone https://github.com/stareing/tasty-rice-plugins.git
cd tasty-rice-plugins
npm install
cd packages/media-stream-grabber
npm run build
```

然后「加载已解压的扩展程序」选 `packages/media-stream-grabber/dist/`。

开发态(HMR):

```bash
npm run dev
```

CRXJS 会把 dev manifest 写进项目根目录,「加载已解压的扩展程序」选项目
根而不是 `dist/`。改文件自动重载。

---

## 需要帮助?

- 提 issue:https://github.com/stareing/tasty-rice-plugins/issues
- 本文源码:[`packages/media-stream-grabber/INSTALL.zh.md`](https://github.com/stareing/tasty-rice-plugins/blob/main/packages/media-stream-grabber/INSTALL.zh.md)
