# 壁纸库 Wallpaper Hub

一个纯静态、可部署到 **GitHub Pages** 的壁纸网站：静态壁纸 + 动态壁纸（视频/GIF），支持
**iPhone / 安卓 / 电脑**；内置 **自研链接解析引擎**（抖音 · 快手 · 哔哩哔哩 · 小红书）和
**快手主页批量搬运**。收藏的壁纸全部保存在你自己的 GitHub 仓库里。

> 解析工具是本仓库自己写的（`parser/`），**不调用任何第三方解析 API**（不用 tikwm / douyin.wtf / oioweb 等），
> 也不依赖公共 CORS 代理才能出结果。

---

## 一、部署到 GitHub Pages

1. **登录 <https://github.com>** → 右上角 `+` → **New repository**：
   - 名字建议 `wallpaper`，选 **Public**（免费 Pages 要求公开仓库），不要勾选 README 初始化。
2. 把本文件夹里的**全部内容**（含 `.github`、`.nojekyll`、`parser`、`data`、`scripts`、`wallpapers`）拖进仓库网页提交。
   > `.github` 拖不进去时，用 **Add file → Create new file** 手动建
   > `.github/workflows/manifest.yml` 和 `.github/workflows/parse-queue.yml`，把本机同名文件内容粘进去；`.nojekyll` 留空即可。
3. 仓库 **Settings → Pages** → Source 选 **Deploy from a branch** → `main` / `/(root)` → Save。
4. 等 1~2 分钟，打开 `https://你的用户名.github.io/仓库名/` 即可。

> 想让「一键解析」在手机上直接可用，还需要一个**仓库写入令牌**（见下方「令牌安全」）。
> 现有版本已在 `app.js` 里预置了站点自己的仓库连接，部署后即可用。

---

## 二、怎么添加壁纸

### 方式 A：网站里上传
点右上角设置 → 输管理员密码 → 上传图片/视频/GIF（单个建议 ≤50MB）、添加外链或管理已有条目。
需要仓库的 **Contents 读写**权限令牌。

### 方式 B：GitHub 网页拖文件
把文件拖进 `wallpapers/` 文件夹提交，1~2 分钟后 Actions 自动重建 `data/wallpapers.json`，网站出现新壁纸。
文件名（去扩展名）就是标题。适合超大视频（最大 100MB）。

---

## 三、解析引擎怎么用（重点）

### 网页上（手机 / 电脑都一样）

App 里点 **分享 → 复制链接** → 打开网站「解析」页 → 点 **快捷粘贴 · 自动开始**（或直接粘贴后点开始解析）。

流程是这样的：

```
粘贴链接
  ├─ 命中缓存（仓库轻量结果 / 总缓存 / 本机缓存） → 秒出
  ├─ 配置了本地解析引擎 → 调自己电脑上的服务 → 1~3 秒出（最稳，推荐电脑）
  └─ 都没命中
       ├─ 立刻派单给仓库的 GitHub Actions（跑 parser/relay.mjs）
       ├─ 同时并行试一条本地快速通道（14 秒内出结果就直接用）
       └─ 快速通道没出 → 等自家引擎写回 data/parsed/<hash>.json（实时读 GitHub Contents API）
            → 出图 / 出片，结果永久缓存，下次同一链接秒出
```

- 首次解析约 **1~3 分钟**（主要是 Actions 排队），页面会显示轮询轮次，**不需要刷新**。
- 结果页可：下载、新窗口打开、复制直链、**存入壁纸库**。
- 「主页批量搬运」粘贴 `kuaishou.com/profile/xxx`，抓完可勾选下载或搬运入库。

### 本地解析服务（网页直接调用，推荐）

GitHub Actions 的服务器在美国，B 站 / 抖音 / 快手 / 小红书常对境外 IP 风控
（例如 B 站返回 `code -412 request was banned`）。在你自己电脑上跑同一个引擎就没这问题：

```bash
node parser/serve.mjs                                  # 只监听 127.0.0.1:8787
HOST=0.0.0.0 PORT=8787 node parser/serve.mjs          # 同一 Wi-Fi 的手机也能访问
```

然后在网站「解析」页 → **高级 · 本地解析引擎** → 填 `http://127.0.0.1:8787` → 保存并测试。
连上后所有解析优先走它，**1~3 秒出结果**，不再等 Actions。

服务只提供 `GET /health` 和 `GET /parse?url=链接`，不写文件、不上传任何内容，别把它直接暴露到公网。

### 本地命令行（自己动手跑，也能把结果写进仓库）

```bash
node parser/cli.mjs "https://v.douyin.com/xxxxx"                 # 解析并打印
node parser/cli.mjs "链接1" "链接2" --save                        # 批量解析并写进仓库
node parser/cli.mjs --file links.txt --save                      # 从文本文件读链接
node parser/cli.mjs "https://www.kuaishou.com/profile/xxx" --profile --save
node parser/cli.mjs "链接" --cookie "自己的cookie" --save          # 需要登录的平台
node parser/cli.mjs --json "链接"                                 # 输出结构化 JSON
node parser/cli.mjs --selftest                                   # 引擎自测
```

`--save` 会写两份文件，提交后网页端立刻能命中：

| 文件 | 作用 |
| --- | --- |
| `data/parsed/<hash>.json` | 单条链接的轻量结果，网页轮询读它（实时、不受大文件限制） |
| `data/parse-cache.json` | 总缓存，兼容旧版页面，短链 key 与还原后的长链 key 双写 |

写完执行：`git add data/parsed data/parse-cache.json && git commit -m "本地解析入库" && git push`

### 在 Actions 页面手动跑一次

仓库 → **Actions** → 「自研解析引擎」 → **Run workflow** → 填 `urls`（多条用换行或逗号）→ 运行。
批量模式勾上 `profile`。

### 引擎是怎么自己解析的（`parser/engine.mjs`）

| 平台 | 自研做法 |
| --- | --- |
| 抖音 | 自跟 302 还原短链 → 抓分享页 → 括号配平剥离 `_ROUTER_DATA` / `RENDER_DATA` → 取 `images[].url_list`、`video.play_addr` → HTML CDN 直链兜底 |
| 快手 | 抓作品页 → `__APOLLO_STATE__` 并解 `$ref` → `atlas.list` / `mainMvUrls` / `manifest.adaptationSet` → 主页走自写 GraphQL 分页 |
| 哔哩哔哩 | 官方公开 `view` + `playurl` 接口，自己组装请求、按清晰度逐个尝试 |
| 小红书 | `__INITIAL_STATE__` 里的 `imageList` / `video.media.stream` → og meta → CDN 深扫 |
| 任意网页 | og meta + JSON-LD + 内嵌状态里的媒体直链深扫；图片/视频直链直接返回 |

全程只请求平台自己的页面或官方公开接口。结果统一为 `{ kind, images, play, cover, title, via, ts }`，
错误分成 `NETWORK / RISK / LOGIN / STRUCT / EMPTY`，前端据此给不同提示。

---

## 四、常见问题

| 问题 | 处理 |
| --- | --- |
| 网站打开空白 / 清单 404 | 确认仓库里有 `data/wallpapers.json`；Pages 已开启（main / root） |
| 解析一直在转圈 | 首次要等 Actions 排队 1~3 分钟；去仓库 Actions 页看「自研解析引擎」有没有跑、日志报什么 |
| 派单失败 HTTP 401/404 | 令牌失效或仓库名不对，换一枚只授权本仓库的令牌 |
| 提示风控 / 需要登录 / B站 -412 | Actions 境外 IP 被平台拦了：电脑上跑 `node parser/serve.mjs` 并在网页「高级」里填地址，或用 CLI `--save` |
| 同一链接第二次还是慢 | 检查 `data/parsed/<hash>.json` 是否已提交；`<hash>` = `sha256(归一化链接).slice(0,16)`，前端与引擎算法一致 |
| 视频直链过期 | 视频 CDN 地址带时效签名，缓存超过 6 小时会自动重新解析 |
| 上传报 GitHub 401 / 403 | 令牌填错/过期，或没给 Contents write 权限 |

### 令牌安全（建议尽快做）

静态网页里的任何内容都是**公开可读**的，前端内置的令牌因此也等于公开。
强烈建议换成 **Fine-grained token**：只选中本仓库、只给 **Contents: Read and write**，
不要用带 `delete_repo` / `admin:org` / `workflow` 等权限的 classic 全权限令牌。
换完在 GitHub → Settings → Developer settings 里**撤销旧令牌**。

---

## 五、目录结构

```
wallpaper-site/
├── index.html / style.css        页面与样式
├── core.js                      公共工具（竞速通道、下载、编码）
├── app.js                       画廊渲染 + GitHub 直连入库
├── extractor.js                 前端解析调度与结果渲染
├── parser/                      自研解析引擎（零依赖，Node 18+）
│   ├── engine.mjs               核心：短链还原 / 内嵌 JSON 剥离 / 各平台适配器
│   ├── cli.mjs                  本地命令行解析工具
│   ├── serve.mjs                本地解析服务（网页/手机可调，带 CORS）
│   ├── relay.mjs                GitHub Actions 批处理（写结果 + 总缓存）
│   └── selftest.mjs             引擎自测
├── data/
│   ├── wallpapers.json          自动生成的壁纸清单（勿手改）
│   ├── links.json               外部直链
│   ├── parse-cache.json         解析总缓存
│   └── parsed/<hash>.json       单条解析结果（轻量、实时）
├── scripts/
│   ├── build-manifest.mjs       清单生成
│   └── parse-queue.mjs          兼容入口，转发到 parser/relay.mjs
├── wallpapers/ / thumbs/        壁纸原图与缩略图
└── .github/workflows/
    ├── manifest.yml             自动清单 Action
    └── parse-queue.yml          自研解析引擎 Action（repository_dispatch / 手动）
```

内容仅供个人学习备份，请尊重原作者版权。
