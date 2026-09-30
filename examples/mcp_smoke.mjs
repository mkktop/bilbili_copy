// MCP stdio 冒烟测试：对 `Weiyu.exe --mcp` 跑 initialize → tools/list → 工具调用。
// 用法：node examples/mcp_smoke.mjs <exe路径>
// 前置：目标 exe 同目录的 settings.json 里 mcp_enabled=true（或在应用设置页开启）。
// 说明：MCP stdio 传输为换行分隔的 JSON-RPC；此脚本即一个最小 MCP 客户端。

import { spawn } from "node:child_process";

const exe = process.argv[2];
if (!exe) {
  console.error("用法: node examples/mcp_smoke.mjs <Weiyu.exe 路径>");
  process.exit(2);
}

const child = spawn(exe, ["--mcp"], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[exe-stderr] ${d}`));
child.on("exit", (code) => console.log(`[exe] 进程退出 code=${code}`));

let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      onMessage(JSON.parse(line));
    } catch (e) {
      console.error("JSON 解析失败:", e.message, "|", line.slice(0, 200));
    }
  }
});

const pending = new Map();
let nextId = 0;

function onMessage(msg) {
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else {
    console.log("[通知]", JSON.stringify(msg).slice(0, 160));
  }
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时(20s)`));
      }
    }, 20000);
  });
}

async function callTool(name, args) {
  const res = await request("tools/call", { name, arguments: args });
  if (res.error) return { isError: true, error: res.error };
  const text = res.result?.content?.[0]?.text ?? "";
  return { isError: !!res.result?.isError, text };
}

function log(label, v) {
  console.log(`\n===== ${label} =====`);
  console.log(typeof v === "string" ? v.slice(0, 400) : JSON.stringify(v, null, 2).slice(0, 400));
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-smoke", version: "0.0.1" },
  });
  log("initialize", {
    protocolVersion: init.result?.protocolVersion,
    serverInfo: init.result?.serverInfo,
    instructions: init.result?.instructions?.slice(0, 120),
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await request("tools/list", {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  log(`tools/list（${names.length} 个）`, names);

  log("get_login_status", await callTool("get_login_status", {}));

  // 限速验证：默认 2 次/秒，连发 5 次网络类工具应耗时 >=2s（本地工具不计入）
  const burst = 5;
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: burst }, () => callTool("get_hot_search", { limit: 1 }))
  );
  const elapsed = Date.now() - t0;
  console.log(`\n===== 限速验证 =====\n并发 ${burst} 次 get_hot_search 耗时 ${elapsed}ms（2次/秒预期 >=2000ms）${results.some((r) => r.isError) ? " | 存在错误!" : " | 全部成功"}`);

  log("get_hot_search", await callTool("get_hot_search", { limit: 5 }));
  log("parse_video(BV1GJ411x7h7)", await callTool("parse_video", { url: "BV1GJ411x7h7" }));
  log("get_video_comments", await callTool("get_video_comments", { bvid: "BV1GJ411x7h7", page: 1, sort: "hot" }));
  log("get_ai_summary", await callTool("get_ai_summary", { bvid: "BV1GJ411x7h7", cid: 137649199, up_mid: 486906719 }));
  log("get_video_danmaku", await callTool("get_video_danmaku", { bvid: "BV1GJ411x7h7", cid: 137649199, limit: 20 }));
  log("get_video_subtitles", await callTool("get_video_subtitles", { bvid: "BV1GJ411x7h7", cid: 137649199 }));
  log("list_downloads", await callTool("list_downloads", { page: 1 }));

  console.log("\n冒烟测试完成");
} catch (e) {
  console.error("冒烟测试失败:", e.message);
  process.exitCode = 1;
} finally {
  child.kill();
  setTimeout(() => process.exit(process.exitCode ?? 0), 300);
}
