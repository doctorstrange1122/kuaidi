# 快递同步后端（Cloudflare Pages + D1，Git 集成部署）

本目录是一个 **Cloudflare Pages Functions** 项目，配合你的 GitHub 仓库做自动部署：
推送代码到 GitHub → Cloudflare Pages 自动拉取并部署 Functions + 绑定 D1 数据库。
App 端（Android）通过 `/api/*` 接口实现多设备登录与快递数据同步。

## 目录结构
```
.
├── functions/
│   ├── _lib/backend.js        # 全部业务逻辑（JWT/PBKDF2/register/login/pull/push）
│   └── api/[[path]].js        # 通配入口，匹配 /api/* 所有请求
├── public/index.html          # 占位首页（Pages 需要构建输出目录）
├── schema.sql                 # D1 建表语句
└── wrangler.toml             # Pages 项目配置
```

## 部署步骤

### 1. 推送到你的 GitHub 仓库
把本目录（`pages-backend/`）下的全部内容推送到一个 GitHub 仓库，例如 `your-name/express-sync`。

### 2. 在 Cloudflare Pages 连接仓库
1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → 创建 → Pages → 连接到 Git**。
2. 授权并选择你的 GitHub 仓库。
3. 构建设置：
   - **构建命令**：留空（Functions 无需构建）
   - **构建输出目录**：`public`
4. 点击「保存并部署」。首次会失败（因为还没建 D1 / 没设密钥），属正常，继续下面步骤。

### 3. 创建 D1 数据库
1. 控制台 → **Workers & Pages → D1** → 创建数据库，名称填 `express_sync`。
2. 进入该数据库 → **Console（控制台）**，把本目录 `schema.sql` 的内容粘贴进去执行，完成建表。
   （或用命令行：`wrangler d1 execute express_sync --remote --file=./schema.sql`）

### 4. 绑定 D1 到 Pages 项目
- 控制台 → 你的 Pages 项目 → **设置 → 绑定 → D1 数据库 → 添加绑定**：
  - 变量名（binding）：`DB`
  - 数据库：`express_sync`

### 5. 设置 JWT 密钥
- 控制台 → 你的 Pages 项目 → **设置 → 环境变量 → 添加变量（生产环境）**：
  - 名称：`JWT_SECRET`
  - 值：一段长随机字符串（本地生成：`openssl rand -hex 32`）

### 6. 重新部署
改完绑定/变量后，回到 **部署** 页点「重新部署」（或再 push 一次触发）。
部署成功后得到形如 `https://<project>.pages.dev` 的地址。

## 7. App 端接入
把上面地址（**不要带结尾斜杠**）填进 App 端 `util/ApiClient.kt`：
```kotlin
const val API_BASE = "https://<project>.pages.dev"
```
App 端「登录 / 注册」后即可多设备同步。

## 接口说明
| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| POST | `/api/register` | `{email,password}` | `{token,userId}` |
| POST | `/api/login` | `{email,password}` | `{token,userId}` |
| GET  | `/api/sync?since=0` | Header `Authorization: Bearer <token>` | `{accounts,express,serverTime}` |
| POST | `/api/sync` | Header `Authorization: Bearer <token>` + `{accounts,express}` | `{serverTime}` |

- 业务主键统一为 `client_id`（App 端生成的 UUID），避免多设备自增 id 冲突。
- 同步冲突以 `updated_at` 较大者胜（last-write-wins）。
- 已删除记录通过 `deleted=1` 软删除标记同步。

## 关于国内网络
`*.pages.dev` 与 `*.workers.dev` 同属 Cloudflare 网络，在中国大陆可能不可达。
若需要大陆稳定访问，可在 Pages 项目「自定义域」绑定你自己的已备案域名（仍走 Cloudflare 节点，改善有限），
后续如需彻底大陆可达，可将后端迁到国内云函数（改动可控）。

## 合规提醒
快递数据含收货人、地址、手机尾号等敏感个人信息。D1 数据存于 Cloudflare 边缘节点（默认美国），
若涉及合规要求，请确认存储地域与《个人信息保护法》的一致性；传输全程 HTTPS，密码经 PBKDF2-SHA256 加盐哈希，服务端不存明文。
