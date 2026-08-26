#!/usr/bin/env node
// workbuddy-mcp --install
// 自动检测本机已安装的 Agent，并把 WorkBuddy MCP Server 注册进去。
// 设计目标：一句 `npx -y workbuddy-mcp --install` 就能完成"装到任意 Agent"。
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 决定注册时用的"启动命令"：
//  - 通过 npx / npm 安装（在 node_modules 里）时，用 `npx -y workbuddy-mcp`，最干净可移植
//  - 本地 clone 直接跑时，用 `node <绝对路径>/server.js`
const viaNpx = __dirname.includes("node_modules");
const command = viaNpx
  ? ["npx", "-y", "workbuddy-mcp"]
  : ["node", join(__dirname, "server.js")];

function which(cmd) {
  try {
    execSync(
      process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`,
      { stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}

const results = [];

// --- Claude Code（有非交互 CLI，注册为全局 user 级）---
if (which("claude")) {
  try {
    execSync(`claude mcp add -s user workbuddy -- ${command.join(" ")}`, {
      stdio: "inherit",
    });
    results.push("Claude Code: 已注册 (claude mcp add -s user)");
  } catch (e) {
    results.push("Claude Code: 注册失败 - " + (e?.message || e));
  }
} else {
  results.push("Claude Code: 未检测到，跳过");
}

// --- Codex（有非交互 CLI）---
if (which("codex")) {
  try {
    execSync(`codex mcp add workbuddy -- ${command.join(" ")}`, {
      stdio: "inherit",
    });
    results.push("Codex: 已注册 (codex mcp add)");
  } catch (e) {
    results.push("Codex: 注册失败 - " + (e?.message || e));
  }
} else {
  results.push("Codex: 未检测到，跳过");
}

// --- Cursor（写 ~/.cursor/mcp.json）---
const cursorDir = join(homedir(), ".cursor");
if (existsSync(cursorDir)) {
  try {
    const cfg = join(cursorDir, "mcp.json");
    const obj = existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")) : {};
    obj.mcpServers = obj.mcpServers || {};
    obj.mcpServers.workbuddy = { command: command[0], args: command.slice(1) };
    writeFileSync(cfg, JSON.stringify(obj, null, 2));
    results.push("Cursor: 已写入 " + cfg);
  } catch (e) {
    results.push("Cursor: 写入失败 - " + (e?.message || e));
  }
} else {
  results.push("Cursor: 未检测到 (~/.cursor 不存在)，跳过");
}

// --- OpenCode（写 ~/.config/opencode/opencode.json）---
const opencodeDir = join(homedir(), ".config", "opencode");
if (existsSync(opencodeDir) || which("opencode")) {
  try {
    const cfg = join(opencodeDir, "opencode.json");
    const obj = existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")) : {};
    obj.mcp = obj.mcp || {};
    obj.mcp.workbuddy = {
      type: "local",
      command: command,
      enabled: true,
      environment: {
        WB_SKIP_PERMISSIONS: "true",
        WB_TIMEOUT: "600000",
      },
    };
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(cfg, JSON.stringify(obj, null, 2));
    results.push("OpenCode: 已写入 " + cfg);
  } catch (e) {
    results.push("OpenCode: 写入失败 - " + (e?.message || e));
  }
} else {
  results.push("OpenCode: 未检测到，跳过");
}

console.log("\n=== workbuddy-mcp 安装结果 ===");
for (const r of results) console.log(" - " + r);
console.log("\n注册用的启动命令：" + command.join(" "));
console.log("提示：被跳过的 Agent 当时未安装属正常；装好该 Agent 后重跑本命令即可生效。");
