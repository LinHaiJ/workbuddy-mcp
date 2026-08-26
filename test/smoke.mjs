/**
 * 最小 MCP 客户端冒烟测试：启动 server.js，走一遍 initialize -> tools/list，
 * 断言 run_workbuddy_task 工具已注册且 schema 合法。
 *
 * 不触发 codebuddy（不需要真实安装/登录），只验证 Server 本身能正常作为
 * MCP Server 被客户端连接。用于 CI 与本地快速自检。
 *
 * 运行：node test/smoke.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "..", "server.js");

const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, WB_TIMEOUT: "5000" },
});

let buffer = "";
const messages = [];

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // 忽略非 JSON 行（理论上 stdio 传输只有 JSON）
      }
    }
  }
});

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function waitFor(pred, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const m = messages.find(pred);
      if (m) return resolve(m);
      if (Date.now() - start > timeout) {
        return reject(new Error("超时：未在 " + timeout + "ms 内收到预期消息"));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function main() {
  // 1. initialize
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0.0" },
    },
  });
  const init = await waitFor((m) => m.id === 1 && m.result);
  if (!init.result?.serverInfo?.name) {
    throw new Error("initialize 响应缺少 serverInfo");
  }

  // 2. 客户端就绪通知
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // 3. tools/list
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsRes = await waitFor((m) => m.id === 2 && m.result);
  const tools = toolsRes.result?.tools ?? [];
  const names = tools.map((t) => t.name);

  if (!names.includes("run_workbuddy_task")) {
    throw new Error(
      "未找到 run_workbuddy_task 工具，实际工具：" + names.join(", ")
    );
  }

  // 4. 校验工具 schema（确保参数定义合法，MCP 客户端才能正确调用）
  const tool = tools.find((t) => t.name === "run_workbuddy_task");
  const props = tool.inputSchema?.properties ?? {};
  if (!props.prompt || props.prompt.type !== "string") {
    throw new Error("run_workbuddy_task 缺少合法的 prompt 参数");
  }
  if (tool.inputSchema?.required?.[0] !== "prompt") {
    throw new Error("run_workbuddy_task 的 prompt 未标记为必填");
  }

  console.log(
    "SMOKE OK — server:",
    init.result.serverInfo.name,
    "v" + init.result.serverInfo.version,
    "| tools:",
    names.join(", ")
  );
  child.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("SMOKE FAIL:", err.message);
  child.kill();
  process.exit(1);
});
