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
 * ⚠️ prompt 传递方式（关键设计）：
 *   prompt 通过 **stdin** 传给 codebuddy，而不是命令行参数。
 *   原因：Windows 上 spawn 需要 shell:true 才能找到 codebuddy.cmd，而 shell:true
 *   模式下 Node 只是把参数简单拼接、不做转义（Node 官方 DEP0190 警告）。若把多行
 *   prompt 放进参数，cmd.exe 会把换行当作命令分隔符——codebuddy 只收到第一行，
 *   其余行被当成独立命令执行（典型症状："WorkBuddy 只看到第一行提示词"）。
 *   另外 prompt 里的 & | < > ^ % 等字符也可能被 cmd.exe 解释。stdin 传输对
 *   长度 / 换行 / 特殊字符完全免疫。
 *
 * 关键配置（环境变量）：
 *   WB_COMMAND          驱动命令，默认 "codebuddy"（别名 cbc）。
 *                       安装：npm install -g @tencent-ai/codebuddy-code
 *   WB_SKIP_PERMISSIONS 是否跳过权限检查，默认 "true"。
 *                       脚本自动化必须跳过，否则文件/网络等工具会被权限卡住；
 *                       若你希望保留交互式授权确认，设成 "false"。
 *   WB_TIMEOUT          单次任务超时(ms)，默认 900000 (15 分钟)。
 *                       长调研任务建议设更大，或在调用时传 timeoutMs。
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
import { spawn } from "node:child_process";
import { z } from "zod";

const WB_COMMAND = process.env.WB_COMMAND ?? "codebuddy";
const WB_SKIP_PERMISSIONS = (process.env.WB_SKIP_PERMISSIONS ?? "true") !== "false";
const rawTimeout = Number(process.env.WB_TIMEOUT);
const WB_TIMEOUT = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 900000;
const WB_DEFAULT_CWD = process.env.WB_CWD;
const WB_DEFAULT_MODEL = process.env.WB_MODEL;
const WB_FALLBACK_MODEL = process.env.WB_FALLBACK_MODEL;

const MAX_CAPTURE = 20 * 1024 * 1024; // stdout/stderr 合计捕获上限

const server = new McpServer({
  name: "workbuddy-mcp",
  version: "0.2.0",
});

/** 去掉 ANSI 颜色/光标控制等转义序列（codebuddy -p 可能带），避免噪音喂给调用方 */
function stripAnsi(s) {
  // 覆盖 CSI 序列（颜色、擦除行 [2K、光标移动 [1G 等）+ OSC 序列
  return s
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * 把"任务选项"翻译成 codebuddy CLI 的实际参数。
 * 注意：prompt 不在此列 —— 它通过 stdin 传入（见文件头说明）。
 */
function buildArgs(opts) {
  const args = ["-p"];
  if (WB_SKIP_PERMISSIONS) args.push("--dangerously-skip-permissions");
  const model = opts.model || WB_DEFAULT_MODEL;
  if (model) args.push("--model", model);
  const fallback = opts.fallbackModel || WB_FALLBACK_MODEL;
  if (fallback) args.push("--fallback-model", fallback);
  if (opts.json) args.push("--output-format", "json");
  return args;
}

/** 超时/中止时杀掉整个进程树（shell:true 下 child.kill 只能杀到 shell 壳） */
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* 尽力而为 */
    }
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 尽力而为 */
    }
  }
}

/** 以 stdin 传 prompt 的方式运行 codebuddy，收集 stdout/stderr */
function runCodebuddy(prompt, args, runCwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(WB_COMMAND, args, {
      // shell:true 让 Windows 能正确解析全局装的 codebuddy.cmd / PATH 查找；
      // args 全部是本模块写死的固定 flag，无用户输入，因此没有注入风险
      shell: true,
      cwd: runCwd || undefined,
      windowsHide: true,
    });

    const chunks = { stdout: [], stderr: [] };
    let captured = 0;
    let timedOut = false;
    const collect = (key) => (d) => {
      captured += d.length;
      if (captured <= MAX_CAPTURE) chunks[key].push(d);
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, timedOut, error: err, stdout: "", stderr: "" });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        timedOut,
        code,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      });
    });

    // prompt 走 stdin；子进程若已提前退出，写管道会 EPIPE，吞掉即可
    child.stdin.on("error", () => {});
    child.stdin.end(prompt, "utf8");
  });
}

server.tool(
  "run_workbuddy_task",
  "委托 WorkBuddy（codebuddy CLI）以非交互方式执行一个任务，返回结果文本。",
  {
    prompt: z
      .string()
      .describe(
        "交给 WorkBuddy 执行的任务描述 / 提示词。可包含多行内容（通过 stdin 传递，不会被截断）"
      ),
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
    timeoutMs: z
      .number()
      .optional()
      .describe(
        `可选：本次调用的超时毫秒数。不传则用 WB_TIMEOUT（当前 ${WB_TIMEOUT}ms）。长调研任务建议 1800000（30 分钟）`
      ),
  },
  async ({ prompt, cwd, model, fallbackModel, json, timeoutMs }) => {
    const runCwd = cwd || WB_DEFAULT_CWD;
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : WB_TIMEOUT;
    const args = buildArgs({ model, fallbackModel, json });
    const r = await runCodebuddy(prompt, args, runCwd, timeout);

    if (r.ok) {
      const text = stripAnsi(
        r.stdout.trim() || r.stderr.trim() || "(WorkBuddy 无文本输出)"
      );
      return { content: [{ type: "text", text }] };
    }

    // 超时：把已产生的部分输出也带回去，调用方可决定是否拆小任务重试
    if (r.timedOut) {
      const partial = stripAnsi((r.stdout || r.stderr || "").trim());
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `任务超过超时上限 ${timeout}ms 被终止。` +
              `长任务建议：(1) 调用本工具时传更大的 timeoutMs（如 1800000）；` +
              `(2) 或把任务拆成多个小步骤分次调用。` +
              (partial ? `\n已产生的部分输出：\n${partial}` : "\n（无部分输出）"),
          },
        ],
      };
    }

    // 启动失败或其他错误
    const detail =
      r.error?.message || r.stderr.trim() || r.stdout.trim() || `退出码 ${r.code}`;
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `调用 WorkBuddy 失败（命令: ${WB_COMMAND} ${args.join(" ")}` +
            (runCwd ? `，cwd: ${runCwd}` : "") +
            `）：\n${detail}\n\n请确认：` +
            `(1) 已执行 npm install -g @tencent-ai/codebuddy-code；` +
            `(2) codebuddy -p "你好" --dangerously-skip-permissions 能正常返回；` +
            `(3) codebuddy 已登录；` +
            `(4) 若 command not found，请用 WB_COMMAND 指到绝对路径（如 C:\\...\\codebuddy.cmd）。`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
