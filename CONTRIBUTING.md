# Contributing / 贡献

Thanks for your interest in `workbuddy-mcp`! This project is intentionally tiny — the whole server is a few hundred lines of plain JavaScript.

## How to contribute / 如何贡献

1. Fork the repo and clone it.
2. `npm install` to pull the MCP SDK + zod.
3. Edit `server.js` / `install.js` / `cli.js`.
4. Syntax-check before pushing: `node --check server.js && node --check install.js && node --check cli.js`.
5. Open a PR with a clear description of the change and why.

## Ideas that fit / 合适的方向

- Streaming output so long tasks show progress.
- Structured JSON result parsing.
- A clearer hint when `codebuddy` is not found / not logged in.

## Local testing / 本地测试

A real end-to-end run requires the WorkBuddy CLI logged in:

```bash
npm install -g @tencent-ai/codebuddy-code
codebuddy -p "hello" --dangerously-skip-permissions
node server.js   # in another terminal; connect any MCP client to stdio
```

Issues labeled `good first issue` are a good starting point.
