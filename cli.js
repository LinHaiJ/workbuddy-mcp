#!/usr/bin/env node
// workbuddy-mcp 入口分发：
//   workbuddy-mcp           -> 启动 MCP Server（供 Agent 客户端连接）
//   workbuddy-mcp --install -> 把本 Server 自动注册到已安装的 Agent
//                              （Claude Code / Codex / Cursor / OpenCode）
const args = process.argv.slice(2);
if (args.includes("--install") || args.includes("-i")) {
  await import("./install.js");
} else {
  await import("./server.js");
}
