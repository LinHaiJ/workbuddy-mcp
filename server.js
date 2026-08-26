#!/usr/bin/env node
/**
 * workbuddy-mcp —— 把 WorkBuddy（codebuddy CLI）包装成 MCP Server，
 * 让 Claude Code / Codex / Cursor / OpenCode 等任意 MCP 客户端把它当"子 Agent"调用。
 *
 * 工作原理：
 *   任意 MCP 客户端（Claude Code / Codex / Cursor / OpenCode ...）
 *     -> 调用本 Server 的 run_workbuddy_task 工具
 *     -> 本 Server 通过 codebuddy CLI（非交互模式 -p）触发 WorkBuddy 真正执行
 *     -> 把执行输出返回给调用方
 *
 * 关键配置（环境变量）：
 *   WB_COMMAND          驱动命令，默认 "codebuddy"（别名 cbc）。
 *                       安装：npm install -g @tencent-ai/codebuddy-code
 *   WB_SKIP_PERMISSIONS 是否跳过权限检查，默认 "true"。
 *                       脚本自动化必须跳过，否则文件/网络等工具会被权限卡住；
 *                       若你希望保留交互式授权确认，设成 "false"。
 *   WB_TIMEOUT          单次任务超时(ms)，默认 600000 (10 分钟)。
 *   WB_CWD              默认工作目录（可选）。当工具调用不传 cwd 时使用，
 *                       决定 codebuddy 在哪个目录读写文件。
 *   WB_MODEL            默认模型（可选）。当工具调用不传 model 时使用，
 *                       如 hy3 / deepseek-v4-flash / glm-5.3 / auto 等。
 *   WB_FALLBACK_MODEL   过载时自动回退的模型（可选）。接到 codebuddy 的
 *                       --fallback-model，仅 --print 模式生效——正是限流/过载场景的救场参数。
 *
 * 重要：先在本机安装并验证 codebuddy：
 *   npm install -g @tencent-ai/codebuddy-code
 *   codebuddy -p "你好" --dangerously-skip-permissions
 * 确认能返回结果后，再接任何 MCP 客户端。
 *
 * 运行：node server.js   （纯 ESM，无需编译，Node 18+ 即可）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const WB_COMMAND = process.env.WB_COMMAND ?? "codebuddy";
const WB_SKIP_PERMISSIONS = (process.env.WB_SKIP_PERMISSIONS ?? "true") !== "false";
const rawTimeout = Number(process.env.WB_TIMEOUT);
const WB_TIMEOUT = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 600000;
const WB_DEFAULT_CWD = process.env.WB_CWD;
const WB_DEFAULT_MODEL = process.env.WB_MODEL;
const WB_FALLBACK_MODEL = process.env.WB_FALLBACK_MODEL;

const server = new McpServer({
  name: "workbuddy-mcp",
  version: "0.1.0",
});

/** 去掉 ANSI 颜色/样式转义码（codebuddy -p 可能带），避免噪音喂给调用方 */
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * 把"任务描述"翻译成 codebuddy CLI 的实际参数。
 * 非交互执行用 -p/--print；需要文件/网络等工具时，必须 --dangerously-skip-permissions。
 * json 可选追加 --output-format json（取决于 codebuddy 版本是否支持，不支持则留空）。
 */
function buildArgs(prompt, opts) {
  const args = ["-p", prompt];
  if (WB_SKIP_PERMISSIONS) args.push("--dangerously-skip-permissions");
  const model = opts.model || WB_DEFAULT_MODEL;
  if (model) args.push("--model", model);
  const fallback = opts.fallbackModel || WB_FALLBACK_MODEL;
  if (fallback) args.push("--fallback-model", fallback);
  if (opts.json) args.push("--output-format", "json");
  return args;
}

server.tool(
  "run_workbuddy_task",
  "委托 WorkBuddy（codebuddy CLI）以非交互方式执行一个任务，返回结果文本。",
  {
    prompt: z.string().describe("交给 WorkBuddy 执行的任务描述 / 提示词"),
    cwd: z
      .string()
      .optional()
      .describe(
        "可选：codebuddy 的工作目录（它在此目录读写文件）。不传则用 WB_CWD 或当前目录"
      ),
    model: z
      .string()
      .optional()
      .describe(
        "可选：指定本次会话模型，如 hy3 / hy3-x / deepseek-v4-flash / glm-5.3 / kimi-k3-1 / auto。不传则用 WB_MODEL 或 codebuddy 默认"
      ),
    fallbackModel: z
      .string()
      .optional()
      .describe(
        "可选：过载/限流时自动回退的模型（接到 --fallback-model，仅 --print 生效）。不传则用 WB_FALLBACK_MODEL"
      ),
    json: z
      .boolean()
      .optional()
      .describe(
        "可选：true 时追加 --output-format json（取决于 codebuddy 版本是否支持）"
      ),
  },
  async ({ prompt, cwd, model, fallbackModel, json }) => {
    const runCwd = cwd || WB_DEFAULT_CWD;
    const args = buildArgs(prompt, { model, fallbackModel, json });
    try {
      const { stdout, stderr } = await execFileAsync(WB_COMMAND, args, {
        // shell:true 让 Windows 能正确解析全局装的 codebuddy.cmd / PATH 查找
        shell: true,
        timeout: WB_TIMEOUT,
        maxBuffer: 20 * 1024 * 1024,
        cwd: runCwd,
      });
      const text =
        stripAnsi(stdout?.trim() || stderr?.trim() || "(WorkBuddy 无文本输出)");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const killed = err?.killed
        ? `\n（任务超过 WB_TIMEOUT=${WB_TIMEOUT}ms 被终止）`
        : "";
      const detail = err?.stdout || err?.stderr || err?.message || String(err);
      return {
        content: [
          {
            type: "text",
            text:
              `调用 WorkBuddy 失败（命令: ${WB_COMMAND} ${args.join(" ")}` +
              (runCwd ? `，cwd: ${runCwd}` : "") +
              `）：${killed}\n${detail}\n\n请确认：` +
              `(1) 已执行 npm install -g @tencent-ai/codebuddy-code；` +
              `(2) codebuddy -p "你好" --dangerously-skip-permissions 能正常返回；` +
              `(3) codebuddy 已登录；` +
              `(4) 若 command not found，请用 WB_COMMAND 指到绝对路径（如 C:\\...\\codebuddy.cmd）。`,
          },
        ],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
