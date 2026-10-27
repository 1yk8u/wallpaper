# 🌈 壁纸库 Wallpaper Hub

一个纯静态、可部署到 **GitHub Pages** 的壁纸网站：静态壁纸 + 动态壁纸（视频/GIF），支持
**iPhone / 安卓 / 电脑**；内置 **链接解析下载**（抖音 · 快手 · 哔哩哔哩 · 小红书）和
**快手主页批量搬运**。收藏的壁纸全部保存在你的 GitHub 仓库里，**永不丢失**。

---

## 一、5 分钟部署到 GitHub Pages（网页上点点点即可，不需要敲命令）

1. **注册/登录 <https://github.com>**。
2. 右上角 `+` → **New repository**（新仓库）：
   - Repository name 建议填 `wallpaper`（或任意名字）；
   - 选 **Public**（免费托管要求公开仓库）；不要勾选 README 初始化；
   - 点 **Create repository**。
3. 回到本文件夹 `wallpaper-site`，**选中全部文件**（含 `.github`、`.nojekyll`、data、scripts、wallpapers 文件夹），拖进 GitHub 新建的仓库页面：
   > GitHub 网页支持直接拖文件夹和隐藏文件；如果 `.github` 拖不动，就在仓库页点 **Add file → Create new file**，文件名填 `.github/workflows/manifest.yml`，把本机同名文件内容粘进去；`.nojekyll` 同理（内容留空）。
4. 拖完点 **Commit changes** 提交。
5. 打开仓库 **Settings → Pages**：
   - Build and deployment → Source 选 **Deploy from a branch**；
   - Branch 选 **main**、目录 **/ (root)** → **Save**。
6. 等 1~2 分钟，刷新该页面会出现网址：`https://你的用户名.github.io/仓库名/` —— 这就是你的壁纸站！手机电脑都能开。

> 以后每次往 `wallpapers/` 加文件或上传预览，网页会自动重新部署（1~2 分钟）。

---

## 二、怎么添加壁纸（两种方式都可）

### 方式 A：网站里上传（最方便，手机也行）⚙️
1. 打开网站 → 右上角 **⚙️ 设置** → 输管理员密码 **12345678**；
2. 首次先填 **📦 仓库配置**：
   - GitHub 用户名 / 仓库名 / 分支 `main`；
   - **PAT 令牌**：GitHub → 头像 → Settings → Developer settings → **Personal access tokens → Fine-grained → Generate new token**：
     - Repository access 选 **Only select repositories** → 选中你的壁纸仓库；
     - Permissions → Repository permissions → **Contents → Read and write**；
     - 生成后立刻复制（只显示一次），粘贴进网站配置 → 保存 → 点「测试连接」变绿即成功。
3. 之后即可：
   - **📤 上传壁纸**：一次多个文件，图片视频 Gif 都行（单个建议 ≤50MB）；
   - **🔗 添加直链**：引用外站图片/视频地址，不占仓库空间；
   - **🗂 内容管理**：删除任意一条；
   - **🔑 修改密码**：改的密码全网生效 ~2 分钟。

### 方式 B：在 GitHub 网页里直接拖文件（适合超大视频，最大 100MB）
1. 仓库 → 进入 `wallpapers` 文件夹 → **Add file → Upload files**；
2. 把图片/视频拖进去 → Commit changes；
3. 等 1~2 分钟：GitHub Actions 自动生成清单 → 网站出现新壁纸。文件名（去掉扩展名）就是标题。

> 工作原理：`wallpapers/` 里的每个文件都会被扫描进 `data/wallpapers.json`（Actions 自动维护）；
> 外部直链保存在 `data/links.json`。都存在你的仓库里 = **永不消失**。
> 建议：Code 页绿色按钮 → Download ZIP 定期备份。

---

## 三、解析 / 批量搬运 使用说明

- **单个链接**（抖音 / 快手 / B站 / 小红书，长链短链都行）：
  App 里点 分享 → 复制链接 → 网站里点 **📋 快捷粘贴** ✓ 自动解析 → 下载或打开后长按保存。
- **快手主页批量搬运**：粘贴类似 `https://www.kuaishou.com/profile/xxxxx` 的主页链接 → 自动抓取该账号全部作品 → 全选/勾选后：
  - **⬇️ 下载选中到设备**：逐个保存到手机/电脑；
  - **→ 搬运到壁纸库**：把选中作品抓下来并提交进你的 GitHub 仓库（需已配置管理员+令牌），从此网站永久可看可下。
- iPhone 批量下载受 Safari 限制（一次一个），分批进行更顺利；也可以直接用「搬运」存网站。

> ⚠️ 解析依赖的公共接口和 CORS 代理（allorigins / codetabs / tikwm / douyin.wtf 等）
> 属于公众服务，偶有失效，稍后重试即可。**快手批量**先抓主页首屏，翻页依赖额外通道，
> 部分网络可能只能抓到部分作品；失败时稍后重试。内容仅供个人学习备份，尊重原作者版权。

---

## 四、常见问题

| 问题 | 处理 |
| --- | --- |
| 网站打开空白/清单 404 | 确认仓库里有 `data/wallpapers.json`；确认 Pages 已开启（来源 main / root） |
| 上传报 GitHub 401 | 令牌填错或过期，重新生成；404 → 检查用户名/仓库名/分支 |
| 上传报 403 rate limit | 令牌权限没给 Contents write；检查 Fine-grained 里是否选了「本仓库」 |
| 每次改完要等几分钟 | GitHub Pages 自动部署的正常耗时（1~2 分钟），浏览器刷新即可 |
| 解析失败 | 公共接口临时抽风：换时段重试；仍失败就「打开原链接」后长按/右键保存 |
| 修改密码后没生效 | config.json 提交后要等 Pages 部署完（~2 分钟）才全网生效 |

## 目录结构
```
wallpaper-site/
├── index.html            网站主体（单页）
├── style.css / core.js / app.js / extractor.js
├── manifest.webmanifest / icon.svg
├── data/wallpapers.json  自动生成的清单（勿手改）
├── data/links.json       管理员添加的外部直链
├── data/config.json      管理员改密码后自动生成
├── wallpapers/           你的壁纸文件都在这里（含视频）
├── scripts/build-manifest.mjs
└── .github/workflows/manifest.yml   自动清单 Action
```

管理员默认密码：**12345678**（登录后请尽快修改）。
