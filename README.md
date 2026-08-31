# WebChat · 网页聊天

给 AI 陪伴机器人做的网页聊天应用。浏览器实时对话，支持流式回复、表情包、文件、图片、群聊、主动唤醒、Bark 推送、记忆与 MCP 工具。

## 功能

- **实时聊天**：SSE 流式回复，边生成边显示；断流不丢已发内容
- **多联系人通讯录**：单聊 / 群聊，微信群式会话列表，消息按时间分组
- **富消息**：代码块渲染、表情包、图片 / 文件发送、自定义表情包收藏
- **主动唤醒**：AI 在空闲时主动发消息，浏览器弹窗通知（可走 Bark）
- **记忆系统**：AI 侧 remember / recall，持续积累长期记忆
- **MCP 工具**：支持 beside-you 的 MCP 与老式 HTTP 接口，展开真实工具名
- **设置面板**：上游模型配置、主题、记忆查看、备份导入导出
- **PWA**：可添加到主屏，离线缓存壳

## 结构

| 文件 | 作用 |
| --- | --- |
| `chat.html` | 前端页面（改动后网关按 mtime 自动重读，无需重启） |
| `chat.js` / `chat-server.js` | 网关逻辑：聊天接口、SSE 流、唤醒、记忆、MCP 路由 |
| `server.js` | 网关启动与静态托管 |
| `sw.js` | Service Worker（PWA 壳） |
| `manifest.json` | PWA 清单 |
| `webchat.json` | 会话数据（聊天记录） |
| `dock/` | 底部 dock 图标与素材 |

## 配置

配置全部走环境变量（`.env`），不随代码提交。核心项：

| 变量 | 说明 |
| --- | --- |
| `TARGET_API_URL` / `TARGET_API_KEY` | 上游模型 API |
| `GATEWAY_API_KEY` | 网关内部端点认证 |
| `INTERNAL_KEY` | 内部唤醒端点共享密钥 |
| `BARK_KEY` | Bark 推送 key（可选） |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 管理认证 |

启动：

```bash
npm install
node server.js
```

> 网关配置（联系人、上游模型、密码等）在 `webchat_config.json`，属本地敏感配置，不纳入版本管理。会话数据 `webchat.json` 亦为运行时数据。

## 说明

本项目从自建服务器同步而来，部分本地调试脚本、密钥与备份文件已按安全原则剔除。请勿将 `.env`、`webchat_config.json` 等敏感文件加入版本控制。
