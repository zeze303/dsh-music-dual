# dsh-music-dual 🎵

**双平台音乐播放器 DeepSeek Harness 插件：网易云音乐 + QQ 音乐。**

基于 [dsh-MusicPlayer](https://github.com/xiekai886/dsh-MusicPlayer) 扩展的悬浮毛玻璃播放器，在保留网易云全部能力的基础上新增 QQ 音乐支持：搜索（zzc 签名算法）、歌单导入、vkey 播放解析、登录态解锁。折叠/展开两种可自由拖动的悬浮窗口形态，host 端状态机 + REST 路由 + agent `music` 工具，浏览器端零外部依赖。

A floating music player plugin for DeepSeek Harness with dual-platform support — NetEase Cloud Music + QQ Music: search, playlist import, stream resolution, and optional login-state unlocks (DSH_MUSIC_COOKIE / DSH_MUSIC_QQ_COOKIE), plus an agent-facing `music` tool.

## 特性 Features

- **悬浮播放器**：右下角深色毛玻璃小卡片，**可拖动记忆位置**，展开/收起带物理曲线动画；播放/暂停、上下首、可拖动进度条、音量、列表循环/单曲循环/随机、播放列表
- **双平台音乐接入**：
  - **网易云**：搜索、歌单导入、三级流解析——优先 `NeteaseCloudMusicApi` 包（cloudsearch / song_url_v1 / playlist_track_all / login_status），包缺失时回退匿名 web API + Meting + outer-link
  - **QQ 音乐**：搜索（安卓端 `musics.fcg` + `zzc` SHA1 混淆签名，smartbox 免签名回退）、歌单导入（`fcg_ucc_getcdinfo_byids_cp`）、播放 URL（`musicu.fcg` → `vkey.GetVkeyServer/CgiGetVkey`，sip+purl 拼接）、登录验证（`fcg_get_profile_homepage`）
- **8KB Range 探测验真**：两平台解析出的播放 URL 都会先拉取前 8KB 校验（状态码 + content-type + 音频 magic），避免拿到 404/HTML 错误页
- **登录态解锁**：网易云 `DSH_MUSIC_COOKIE`（MUSIC_U）、QQ 音乐 `DSH_MUSIC_QQ_COOKIE`（uin + qm_keyst），配置后可解锁会员/VIP 曲目的完整音频
- **agent 音乐工具**：对模型说"放首歌 / 把我的歌单放进去 / QQ 音乐搜一下"即可——`music` 工具支持 `platform` 参数双平台搜索/导入/播放
- **状态同步**：浏览器播放器与 host 状态机通过 REST 同步（`/dsh-music/state` 轮询 + `/dsh-music/command` 控制），无持久化
- **零外部前端依赖**：播放器为手写 `__ModuleLoader__` 格式，内联 SVG 图标，不依赖 CDN

## 安装 Install

需要 [DSH CLI](https://github.com/deepseek-ai/deepseek-harness) 与 pnpm：

```sh
# 从 GitHub 安装
dsh plugin --profile web add "github:zeze303/dsh-music-dual"
# 或本地源码安装（开发调试）
dsh plugin --profile web add "file:E:/WorkSpace/Competition/dsh-music-dual"
```

重启 `dsh web`（`dsh --profile web`）后生效，页面右下角出现 🎵 播放器。

> 注意：网易云的签名接口依赖 `NeteaseCloudMusicApi` npm 包（自动作为依赖安装）；包缺失时自动回退匿名 API，功能仍可用。

## 配置 Configuration

### 默认歌单（网易云）

```sh
# 例如把默认曲库设为歌单 13060319975
set DSH_MUSIC_PLAYLIST=13060319975
dsh --profile web
```

未设置时播放列表为空，可打开播放器 🔍 手动导入歌单。

### 登录态解锁（可选）

```sh
# 网易云：从浏览器网易云登录态复制 MUSIC_U=... 等必要 cookie
set DSH_MUSIC_COOKIE=MUSIC_U=xxxx;__csrf=xxxx

# QQ 音乐：从浏览器 y.qq.com 登录态复制 uin=...; qm_keyst=...
# 注意：必须包含 qm_keyst（或 qqmusic_key/music_key）播放授权票据，
# 只有 uin + qqmusic_key 的"网页登录态"无法换取完整播放地址
set DSH_MUSIC_QQ_COOKIE=uin=123456789;qm_keyst=xxxx
dsh --profile web
```

配置后插件将携带登录态解析播放地址（有对应权益的歌曲返回完整音频）。Cookie 仅保存在本机环境变量中，不会上传到任何第三方。未配置时自动回退匿名解析（仅免费曲目可播）。

> ⚠️ 仅用于个人使用；账号权益以各平台实际返回为准。VIP/版权受限曲目未登录时：网易云返回翻唱替代或试听，QQ 音乐返回 `104003` 错误码。

## 使用 Usage

- 点右下角 🎵 卡片展开播放器；拖动卡片顶部任意位置可移动（位置自动记忆）；点右上角箭头展开/收起（带动画）
- 点 🔍 进入搜索面板：顶部 tab 切换 **网易云 / QQ 音乐**，输入歌名/歌手回车搜索，点 + 加入播放列表
- 第一行输入框粘贴当前平台歌单链接或 id，回车一键导入（替换当前曲库）
- 对话里直接说「放首歌 / 放一首周杰伦的晴天 / QQ 音乐搜一下晴天 / 导入我的歌单 / 下一首 / 暂停 / 随机播放 / 音量调到 50%」，agent 会调用 `music` 工具控制播放器

## agent music 工具

| action | 说明 |
|---|---|
| `play` | 播放；`query` 先匹配本地曲库，未命中自动搜索指定平台并加入播放 |
| `search` | 搜歌（`platform`: netease/qq） |
| `playlist` | 导入歌单（`platform` + `id`/`url`） |
| `pause` / `next` / `prev` / `list` | 播放控制与队列查看 |
| `add` / `remove` | 添加直链 / 按索引移除 |
| `volume` / `mode` | 音量 0-1 / 循环模式 list·single·shuffle |
| `builtin` / `reset` | 恢复/隐藏默认歌单 / 重置 |

## REST API

| 端点 | 说明 |
|---|---|
| `GET /dsh-music/state` | 播放器状态快照 |
| `POST /dsh-music/command` | 播放意图（`importPlaylist` 支持 `platform`） |
| `GET /dsh-music/netease/{search,playlist,stream,login}` | 网易云搜索/歌单/音频代理/登录态 |
| `GET /dsh-music/qq/{search,playlist,stream,login}` | QQ 音乐搜索/歌单/音频代理/登录态 |

## 目录结构 Structure

- `index.js` — host 端：状态机、REST 路由、`music` 工具、双平台解析（NeteaseCloudMusicApi 优先 + 回退、QQ zzc 签名/vkey）、8KB 探测
- `client.js` — 浏览器端：悬浮播放器（`__ModuleLoader__` 格式、平台切换、零外部依赖）
- `cordis.patch.yml` — bundle 层声明
- `package.json` — 包元数据（依赖 `NeteaseCloudMusicApi`）

## 免责声明 Disclaimer

- 本项目与 DeepSeek、网易云音乐、QQ 音乐/腾讯音乐娱乐集团无关；音频来自各平台公开接口与第三方解析服务，仅供学习交流
- 受版权/VIP 限制的歌曲可能无法播放
- `music` 工具与 UI 的操作均在本地 DSH 实例内完成
- 本项目基于 [dsh-MusicPlayer](https://github.com/xiekai886/dsh-MusicPlayer)（MIT）扩展，QQ 音乐接入参考 [Mineradio](https://github.com/xiaoyangcheng84-svg/dsh-skin-manager) 项目的开源实现思路

## License

[MIT](LICENSE)
