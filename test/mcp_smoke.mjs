// 冒烟测试：以 MCP stdio 协议连接 server.js，
// 用多行 prompt 调用 run_workbuddy_task，验证内容完整到达 WorkBuddy。
// 运行：node test/mcp_smoke.mjs   （需本机 codebuddy 已登录可用）
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = spawn(process.execPath, ["server.js"], { cwd: root });


let buf = "";
let nextId = 1;
const pending = new Map();

server.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* 忽略非 JSON 行 */ }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0.0.1" },
});
console.log("initialize OK:", init.result?.serverInfo?.name, init.result?.serverInfo?.version);
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = await rpc("tools/list", {});
console.log("tools:", tools.result?.tools?.map((t) => t.name).join(", "));

const prompt = [
  "冒烟测试（只回复，不要执行任何工具）：",
  "1. 请原样复述下面这行的内容：AAA-多行第一层",
  "2. 第二行 BBB-多行第二层",
  "3. 第三行 CCC-多行第三层 & 特殊字符 <测试> | 管道 ^ 转义",
  "",
  "请在最终回复里逐行列出 1/2/3 行是否完整收到。",
].join("\n");

const t0 = Date.now();
const res = await rpc("tools/call", {
  name: "run_workbuddy_task",
  arguments: { prompt, timeoutMs: 180000 },
});
console.log(`tools/call 用时 ${(Date.now() - t0) / 1000}s`);
const text = res.result?.content?.[0]?.text ?? JSON.stringify(res);
console.log("=== WorkBuddy 返回 ===");
console.log(text);

const ok = ["AAA-多行第一层", "BBB-多行第二层", "CCC-多行第三层"].every((s) => text.includes(s));
console.log(ok ? "\n[PASS] 多行+特殊字符 prompt 完整到达" : "\n[FAIL] prompt 内容缺失");
server.kill();
process.exit(ok ? 0 : 1);
