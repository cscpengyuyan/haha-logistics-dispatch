# HAHA V8 协作后端

这是随 V8 提供的**可运行、可自行部署的协作基础服务**。GitHub Pages 只托管前端文件，不会运行本目录的 Node 服务。仓库中没有已配置的服务器、真实客户数据、账户密码或服务商密钥。

服务将受信管理员/调度员的完整工作区保存在 SQLite，提供登录、只读角色、版本冲突保护和独立审计。前端未连接时仍使用本机演示数据；部署本服务并在 V8“数据与协作”中登录后，可显式上传或读取共享工作区。

## 能力边界

| 能力 | 本目录实现 |
| --- | --- |
| 工作区跨设备读写 | 已实现，SQLite 持久化，完整状态同步 |
| admin / dispatcher / readonly | 已实现，服务端强制只读角色禁写 |
| 登录会话 | 随机 Bearer token，数据库只保存 SHA-256 摘要，默认有效 8 小时 |
| 密码 | 随机盐 + scrypt，恒时比较，不提供默认密码 |
| 并发修改 | 必须提供上次读取的 version；旧版本写入返回 409 |
| 审计 | 服务器记录操作者、动作、时间、版本和集合数量，独立于客户端 audit 数组 |
| 备份 | 提供 SQLite 在线一致性备份脚本 |
| 客户/司机订单级授权 | 未实现；不要向外部客户或司机分发本服务账号 |
| 附件上传及对象存储 | 未接入；现有演示附件仍只是元数据 |
| 真正短信发送、回执、退订 | 未接入；健康接口明确报告 false |
| 货车道路里程/实时交通 | 未接入；健康接口明确报告 false |

本服务不是完整 TMS 权限系统。`admin` 和 `dispatcher` 都能读取和修改整个工作区，`readonly` 能读取整个工作区。账号管理仅通过持有服务器系统权限的本机 CLI 完成。已实现的全量状态接口适合少量受信人员协作；正式承运放行、客户门户和司机端还需要逐订单授权、服务器业务校验及真实服务接入。

## 运行要求

- Node.js **24.22 或更新的 24.x**，无需安装 npm 包。
- 可持久保存的磁盘；服务器默认监听 `127.0.0.1:8787`。
- 公网使用必须由反向代理提供 HTTPS。不要让密码或 Bearer token 经明文公网 HTTP 传输。
- 将数据库目录放在前端静态目录之外。GitHub Pages 不会执行服务端代码。

官方 API 参考：[Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)、[Node.js Crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)。本仓库测试使用 Node.js 24.22.1。

## 首次启动

在仓库根目录执行。以下命令在终端隐藏输入口令，避免把密码写入命令历史；请使用自己生成的独立长密码（至少 16 个字符）。

```bash
read -r -s -p "管理员密码: " HAHA_ADMIN_PASSWORD
export HAHA_ADMIN_PASSWORD
export HAHA_ADMIN_USERNAME=admin
export HAHA_ALLOWED_ORIGINS=https://cscpengyuyan.github.io
export HAHA_DATABASE_PATH=/var/lib/haha-logistics/workspace.sqlite
node server/server.mjs
```

先为运行服务的系统账号创建可写的 `/var/lib/haha-logistics` 目录；如果仅在本机测试，可以把 `HAHA_DATABASE_PATH` 改为当前账号拥有的非公开目录。未设置数据库路径时使用 `server/data/workspace.sqlite`，该目录已加入本目录的 `.gitignore`。

第一次启动在空数据库创建管理员。以后启动会使用现有数据库，不会因为环境变量变更而重设口令；修改口令使用下方 CLI。部署时把秘密配置交给服务管理器或托管平台的秘密配置系统，不要提交到仓库。完成前台试运行后，可在停止服务的终端执行 `unset HAHA_ADMIN_PASSWORD`。

| 环境变量 | 默认值 / 要求 |
| --- | --- |
| `HAHA_ADMIN_PASSWORD` | 仅空数据库首次启动必需；16–1024 字符 |
| `HAHA_ADMIN_USERNAME` | `admin`；用户名为 3–64 位字母、数字、点、横线、下划线 |
| `HAHA_DATABASE_PATH` | `server/data/workspace.sqlite` |
| `HAHA_ALLOWED_ORIGINS` | 空；必须明确配置浏览器前端来源，多个用逗号分隔 |
| `HAHA_HOST` | `127.0.0.1` |
| `HAHA_PORT` | `8787` |

来源应是 **origin**，例如 `https://cscpengyuyan.github.io`，不带 `/haha-logistics-dispatch/v8/` 路径。只允许完整 HTTPS 来源；本机开发允许 `http://localhost:端口` 或 `http://127.0.0.1:端口`。不支持 `*`。使用命令行 API 客户端没有 Origin 头时仍必须正常登录并鉴权。

反向代理应原样转发 `/api/v1/` 路径和 `Authorization` 头，设置合理的请求限制；服务最大 JSON 请求体为 5 MiB，登录请求体为 16 KiB。服务不信任 `X-Forwarded-For`，避免伪造地址绕过限速。代理后的多个用户可能共用一个地址限额，团队规模变大时应在受控代理层增加真实客户端地址限速，而不是直接信任公开请求头。

## 账户管理

所有命令都使用同一个 `HAHA_DATABASE_PATH`。`set` 可创建账户或重置已有账户密码/角色，会撤销该用户旧会话。不会打印密码。

```bash
read -r -s -p "新用户密码: " HAHA_NEW_USER_PASSWORD
export HAHA_NEW_USER_PASSWORD
node server/manage-user.mjs set dispatch01 --role dispatcher
unset HAHA_NEW_USER_PASSWORD
```

其他操作：

```bash
node server/manage-user.mjs list
node server/manage-user.mjs disable dispatch01
```

支持的角色为 `admin`、`dispatcher`、`readonly`。不能停用或降级最后一个启用的管理员。

## API 契约

所有响应均禁止缓存，数据响应为 `application/json`。登录后使用 `Authorization: Bearer <token>`，不会设置 Cookie。前端应仅在当前页面内存中保留 token，不放入 URL、日志或浏览器长期存储。

### 健康与接入状态

`GET /api/v1/health`，不需要登录：

```json
{
  "ok": true,
  "service": "HAHA Logistics workspace API",
  "version": "8.0",
  "mode": "server",
  "capabilities": {
    "workspaceSync": true,
    "auditLog": true,
    "accounts": true,
    "attachments": false,
    "sms": false,
    "truckRouting": false,
    "orderScopedAccess": false
  }
}
```

### 登录、查看会话、退出

- `POST /api/v1/session`，JSON `{ "username": "admin", "password": "用户输入的密码" }`。
- 成功 `201`：`{ "token": "随机令牌", "expiresAt": "UTC ISO 时间", "user": { "username": "admin", "role": "admin" } }`。
- `GET /api/v1/session`：已登录账号与会话到期时间。
- `DELETE /api/v1/session`：撤销当前 token，成功 `204`。

登录失败不区分用户名不存在或密码错误。每个用户名每分钟最多 5 次尝试，每个网络地址每分钟最多 20 次。超过返回 `429` 和 `Retry-After`。该限制使用进程内计数，服务重启后重置；公网还需代理层防滥用。

### 读取共享工作区

`GET /api/v1/workspace`：

```json
{
  "version": 0,
  "state": null,
  "updatedAt": null,
  "updatedBy": null
}
```

新服务器返回空工作区。已有数据时 `state` 是完整 schema 7 对象，包含订单、库存及其他扩展字段。后端不会自动写入演示数据。

### 显式上传或同步工作区

`PUT /api/v1/workspace`，仅 `admin` / `dispatcher`：

```json
{
  "version": 0,
  "state": {
    "schema": 7,
    "orders": [],
    "inventory": [],
    "inbound": [],
    "suppliers": [],
    "warehouses": [],
    "models": [],
    "vehicles": [],
    "batches": [],
    "risks": [],
    "messages": [],
    "forms": [],
    "audit": [],
    "settings": {},
    "cost": {}
  }
}
```

实际前端应传入完整工作区；示例仅展示最小结构。成功 `200` 返回 `{ "version": 1, "updatedAt": "UTC ISO 时间", "updatedBy": "admin" }`。客户端应保存返回的新版本号。

若有人抢先写入，服务返回 `409`：

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "其他成员已更新工作区，请先读取最新版并核对差异。"
  },
  "currentVersion": 2
}
```

**收到 409 后不要自动用新 version 重试旧数据。**先保存本机备份，再读取最新版、核对差异，决定后续合并。版本检查、数据更新和服务器审计在同一个 SQLite 事务内完成。

导入要求 schema 为 7，包含示例列出的全部业务数组以及 `settings` 和 `cost` 对象；订单、型号、仓库、供应商、车组、批次 ID 及库存序列号不为空且唯一。非空的订单、库存、车组、到仓计划和批次引用必须指向存在的记录，批次中的订单不能重复。草案可以保留空引用，但不能引用不存在的记录。服务拒绝原型污染键、HTML 标签或可执行 URL、过深结构及过大的集合。未知的安全扩展字段会原样保留。服务器审计表不会被上传的客户端 `audit` 数组替换。这些是结构与引用校验，不替代真正放行时的库存、预约、服务能力等业务校验。

### 审计

`GET /api/v1/audit?limit=50&before=100`。`limit` 为 1–100；`before` 可省略。

返回 `{ "items": [{ "id", "at", "actor", "action", "version", "details" }], "nextBefore": null }`。有下一页时，把 `nextBefore` 作为下一次请求的 `before`。日志不包含登录口令、Bearer token 或完整客户数据。

### 错误处理

统一形状：`{ "error": { "code": "错误代码", "message": "可读说明" } }`。

| HTTP | 典型情况 |
| --- | --- |
| 400 | JSON/工作区结构无效，缺少版本号 |
| 401 | 未登录、token 过期、账号已停用 |
| 403 | 来源未授权、readonly 尝试写入 |
| 409 | 共享工作区版本冲突 |
| 413 | 请求体超过上限 |
| 415 | 不支持的 Content-Type 或压缩请求体 |
| 429 | 登录限速 |
| 500 | 未暴露内部堆栈的服务错误 |

## 备份与恢复

使用 SQLite 在线备份 API，运行时可备份，不要直接复制正在写入的 `.sqlite` 文件而漏掉 WAL：

```bash
node server/backup.mjs /secure-backups/haha-workspace-2026-10-28.sqlite
```

脚本要求目标文件不存在，保留原数据库，备份文件权限为当前账号可读写。备份包含全部共享数据、账号哈希、会话与审计，应与数据库同样保护，并保存在独立持久介质上。

恢复时停止服务，将已验证的备份恢复到新的数据库路径，用 `HAHA_DATABASE_PATH` 指向它后启动。先验证订单数量、版本和关键记录，再切换正式入口。恢复会话表后可以使用 `manage-user.mjs set` 重置相关账号口令并撤销旧会话。建立符合实际业务需要的备份频率与保留期。

## 验证

从仓库根目录运行：

```bash
node --test tests/server-v8.test.mjs
```

测试通过真实本地 HTTP 请求验证登录、CORS、角色授权、旧版本写入冲突、导入安全、完整 V8 演示数据读写、独立审计、限速、注销、SQLite 重启持久化、在线备份与账户 CLI。测试使用临时数据库和测试口令，结束后清理。受限执行环境需要允许监听本机临时端口。
