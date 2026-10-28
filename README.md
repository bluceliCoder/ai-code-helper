# CodePilot · AI 代码助手

轻量化 AI 编程工作台：Vue 3 + Monaco Editor 前端、Express SSE 服务端、豆包方舟大模型，以及可选的 MySQL 生成历史。

## 环境要求

- Node.js 20 或更高版本
- npm 10 或更高版本
- Docker Compose（可选，用于本地 MySQL）
- 豆包方舟 API Key 和推理接入点 ID

## 快速开始

1. 复制 `.env.example` 为 `.env`，填写 `DOUBAO_API_KEY` 和 `DOUBAO_MODEL_ID`。密钥只保存在服务端环境变量中，不要将 `.env` 提交到版本库。
2. 安装依赖并启动前后端：

   ```bash
   npm install
   npm run dev
   ```

3. 打开 <http://localhost:5173>。开发环境中的 `/api` 请求由 Vite 代理到 `http://localhost:3000`，请从项目根目录运行 `npm run dev` 同时启动前后端。

本地 npm 使用镜像时，若镜像不可用，可运行 `npm install --registry=https://registry.npmjs.org`。

## MySQL 历史记录

生成历史默认写入 MySQL。先在 `.env` 中配置 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD` 和 `MYSQL_DATABASE`，再启动数据库：

```bash
docker compose up -d mysql
npm run dev
```

服务启动时会检查数据库连接并自动创建 `generations` 表。未配置 MySQL 时，代码生成仍可使用，但历史列表不可用。数据库配置不完整或连接失败会明确报错，服务不会伪装成已启用历史记录。

如果只希望不启用历史记录，请从 `.env` 中移除所有 `MYSQL_*` 配置。

## 配置

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `DOUBAO_API_KEY` | 豆包方舟 API 密钥 | 无 |
| `DOUBAO_MODEL_ID` | 推理接入点 ID / 模型 ID | 无 |
| `DOUBAO_BASE_URL` | 方舟 API 地址；可填写 API 根地址或完整的 `/chat/completions` 地址 | `https://ark.cn-beijing.volces.com/api/v3` |
| `MYSQL_HOST` / `MYSQL_PORT` | MySQL 地址和端口 | `127.0.0.1` / `3306` |
| `MYSQL_USER` / `MYSQL_PASSWORD` | MySQL 用户名和密码 | 无 |
| `MYSQL_DATABASE` | 历史记录数据库 | 无 |
| `PORT` | 后端 HTTP 端口 | `3000` |
| `CORS_ORIGIN` | 允许访问 API 的前端源 | `http://localhost:5173` |
| `VITE_API_BASE_URL` | 前端 API 地址 | `http://localhost:3000` |
| `API_PROXY_TARGET` | Vite 开发代理的后端地址 | `http://localhost:${PORT}` |

`VITE_API_BASE_URL` 是 Vite 构建时读取的生产环境 API 地址；开发环境统一通过 Vite `/api` 代理访问后端。需要自定义开发端口时设置 `PORT`，需要自定义代理地址时设置 `API_PROXY_TARGET`。修改后需重启开发服务器。

## 功能

- Monaco Editor 多语言高亮、语言切换、代码复制和响应式工作台。
- 自然语言 Prompt 生成代码，服务端将豆包 SSE 增量安全转发，编辑器以打字机效果呈现。
- 最近生成记录写入 MySQL，可从侧栏载入历史代码。
- 服务端限制请求体和并发数，添加 API 速率限制、安全响应头及 CORS 来源约束；浏览器断开时会取消上游生成请求。

## API

- `GET /api/health`：服务状态。
- `GET /api/history`：最近 30 条生成记录；MySQL 未配置时返回 `503`。
- `POST /api/generate`：请求体为 `{ "prompt": "...", "language": "typescript" }`，成功后返回 `text/event-stream`，每个 `data:` 事件包含一个增量 `delta`，结束事件包含 `done: true`。

## 构建

```bash
npm run build
```
