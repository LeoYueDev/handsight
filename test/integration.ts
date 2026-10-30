import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(os.tmpdir(), "hindsight-test-" + Date.now());
fs.mkdirSync(testDir, { recursive: true });

process.env.HINDSIGHT_DATA_DIR = testDir;
process.env.HINDSIGHT_CONFIG_DIR = path.join(testDir, ".config");

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(__dirname, "..", "dist", "index.js")],
    env: { ...process.env, HINDSIGHT_DATA_DIR: testDir },
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("=== Available Tools ===");
  for (const tool of tools.tools) {
    console.log(`  - ${tool.name}: ${tool.description}`);
  }

  console.log("\n=== Test: record_conversation ===");
  const r1 = await client.callTool({
    name: "record_conversation",
    arguments: {
      role: "user",
      content: "不要用 class，我更喜欢函数式风格",
      project: "test",
    },
  });
  console.log("  Result:", (r1.content as any)[0].text);

  console.log("\n=== Test: record_conversation ===");
  const r2 = await client.callTool({
    name: "record_conversation",
    arguments: {
      role: "user",
      content: "我决定用 Koa 而不是 Express",
      project: "test",
    },
  });
  console.log("  Result:", (r2.content as any)[0].text);

  console.log("\n=== Test: add_memory ===");
  const r3 = await client.callTool({
    name: "add_memory",
    arguments: {
      type: "preference",
      content: "error_handling: always uses async/await with try/catch",
      confidence: 0.9,
      project: "test",
    },
  });
  console.log("  Result:", (r3.content as any)[0].text);

  console.log("\n=== Test: refresh_profile ===");
  const r4 = await client.callTool({
    name: "refresh_profile",
    arguments: { project: "test" },
  });
  console.log("  Result:", (r4.content as any)[0].text);

  console.log("\n=== Test: get_user_context ===");
  const r5 = await client.callTool({
    name: "get_user_context",
    arguments: { project: "test" },
  });
  console.log("  Result:", (r5.content as any)[0].text);

  console.log("\n=== Test: get_memories ===");
  const r6 = await client.callTool({
    name: "get_memories",
    arguments: { project: "test" },
  });
  console.log("  Result:", (r6.content as any)[0].text);

  console.log("\n=== Test: start_file_watching ===");
  const watchDir = path.join(testDir, "watched");
  fs.mkdirSync(watchDir, { recursive: true });
  const r7 = await client.callTool({
    name: "start_file_watching",
    arguments: { path: watchDir, project: "watch-test" },
  });
  console.log("  Result:", (r7.content as any)[0].text);

  console.log("\n=== Test: 文件变更触发事件记录 ===");
  fs.writeFileSync(path.join(watchDir, "created.ts"), "const a = 1;");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  fs.writeFileSync(path.join(watchDir, "created.ts"), "const a = 2;");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  fs.rmSync(path.join(watchDir, "created.ts"));
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const r8 = await client.callTool({
    name: "get_file_events",
    arguments: { project: "watch-test", limit: 50 },
  });
  const events = JSON.parse((r8.content as any)[0].text) as any[];
  const actions = new Set(events.map((e) => e.action));
  console.log(`  捕获 ${events.length} 条事件, actions: ${[...actions].join(", ")}`);
  if (!actions.has("create") || !actions.has("modify") || !actions.has("delete")) {
    throw new Error(`文件监控事件缺失, 实际捕获 actions: ${[...actions].join(", ")}`);
  }

  console.log("\n=== Test: stop_file_watching ===");
  const r9 = await client.callTool({ name: "stop_file_watching", arguments: {} });
  console.log("  Result:", (r9.content as any)[0].text);

  console.log("\n=== Test: 非数字 limit 应被拒绝 ===");
  for (const tool of ["get_memories", "search_memories"]) {
    const args: Record<string, unknown> = { project: "test", limit: "50" };
    if (tool === "search_memories") args.query = "error";
    let rejected = false;
    try {
      const res = await client.callTool({ name: tool, arguments: args });
      rejected = Boolean(res.isError);
    } catch (err) {
      rejected = (err as Error).message.includes("Invalid limit");
    }
    if (!rejected) {
      throw new Error(`${tool}: 非数字 limit 未被拒绝`);
    }
    console.log(`  ${tool}: 已拒绝非数字 limit`);
  }

  console.log("\n=== Test: 非法 type 应被拒绝 ===");
  for (const tool of ["get_memories", "search_memories"]) {
    const args: Record<string, unknown> = { project: "test", type: "bogus" };
    if (tool === "search_memories") args.query = "error";
    let rejected = false;
    try {
      const res = await client.callTool({ name: tool, arguments: args });
      rejected = Boolean(res.isError);
    } catch (err) {
      rejected = (err as Error).message.includes("Invalid type");
    }
    if (!rejected) {
      throw new Error(`${tool}: 非法 type 未被拒绝`);
    }
    console.log(`  ${tool}: 已拒绝非法 type`);
  }

  console.log("\n=== Test: 小数 limit/offset 应被拒绝 ===");
  const cases: { tool: string; args: Record<string, unknown>; expect: string }[] = [
    { tool: "get_memories", args: { project: "test", limit: 1.5 }, expect: "Invalid limit" },
    { tool: "search_memories", args: { query: "error", limit: 1.5 }, expect: "Invalid limit" },
    { tool: "get_recent_conversations", args: { project: "test", limit: 1.5 }, expect: "Invalid limit" },
    { tool: "get_file_events", args: { project: "test", limit: 1.5 }, expect: "Invalid limit" },
    { tool: "export_data", args: { project: "test", limit: 1.5 }, expect: "Invalid limit" },
    { tool: "export_data", args: { project: "test", offset: 1.5 }, expect: "Invalid offset" },
  ];
  for (const c of cases) {
    let ok = false;
    try {
      const res = await client.callTool({ name: c.tool, arguments: c.args });
      ok = Boolean(res.isError) && ((res.content as any)[0]?.text ?? "").includes(c.expect);
    } catch (err) {
      ok = (err as Error).message.includes(c.expect);
    }
    if (!ok) {
      throw new Error(`${c.tool} ${JSON.stringify(c.args)}: 小数参数未被拒绝`);
    }
    console.log(`  ${c.tool} ${JSON.stringify(c.args)}: 已拒绝`);
  }

  console.log("\n=== Test: 读取路径非字符串 project 应被拒绝 ===");
  const readCases: { tool: string; args: Record<string, unknown> }[] = [
    { tool: "get_memories", args: { project: [1, 2] } },
    { tool: "search_memories", args: { query: "error", project: {} } },
    { tool: "get_stats", args: { project: [1, 2] } },
    { tool: "get_recent_conversations", args: { project: {} } },
    { tool: "get_file_events", args: { project: [1, 2] } },
    { tool: "export_data", args: { project: {} } },
    { tool: "get_user_context", args: { project: [1, 2] } },
  ];
  for (const c of readCases) {
    let ok = false;
    try {
      const res = await client.callTool({ name: c.tool, arguments: c.args });
      ok = Boolean(res.isError) && ((res.content as any)[0]?.text ?? "").includes("Invalid project");
    } catch (err) {
      ok = (err as Error).message.includes("Invalid project");
    }
    if (!ok) {
      throw new Error(`${c.tool} ${JSON.stringify(c.args)}: 非字符串 project 未被拒绝`);
    }
    console.log(`  ${c.tool}: 已拒绝非字符串 project`);
  }

  console.log("\n=== Test: stop_file_watching 非字符串 path 应被拒绝 ===");
  for (const badPath of [123, {}, ["a"]]) {
    let ok = false;
    try {
      const res = await client.callTool({ name: "stop_file_watching", arguments: { path: badPath } });
      ok = Boolean(res.isError) && ((res.content as any)[0]?.text ?? "").includes("Invalid path");
    } catch (err) {
      ok = (err as Error).message.includes("Invalid path");
    }
    if (!ok) {
      throw new Error(`stop_file_watching path=${JSON.stringify(badPath)}: 非字符串未被拒绝`);
    }
    console.log(`  path=${JSON.stringify(badPath)}: 已拒绝`);
  }

  console.log("\n=== Test: refresh_profile 非字符串 project 应被拒绝 ===");
  for (const badProj of [[1, 2], {}]) {
    let ok = false;
    try {
      const res = await client.callTool({ name: "refresh_profile", arguments: { project: badProj } });
      ok = Boolean(res.isError) && ((res.content as any)[0]?.text ?? "").includes("Invalid project");
    } catch (err) {
      ok = (err as Error).message.includes("Invalid project");
    }
    if (!ok) {
      throw new Error(`refresh_profile project=${JSON.stringify(badProj)}: 非字符串未被拒绝`);
    }
    console.log(`  project=${JSON.stringify(badProj)}: 已拒绝`);
  }

  console.log("\n=== Test: update_memory 撞重复 content 应返回干净错误 ===");
  await client.callTool({ name: "add_memory", arguments: { type: "preference", content: "dup-a", project: "test" } });
  const addB = await client.callTool({ name: "add_memory", arguments: { type: "pattern", content: "dup-b", project: "test" } });
  const idB = Number(((addB.content as any)[0].text.match(/ID: (\d+)/) ?? [])[1]);
  let cleanReject = false;
  try {
    const res = await client.callTool({ name: "update_memory", arguments: { id: idB, content: "dup-a" } });
    const text = (res.content as any)[0]?.text ?? "";
    cleanReject = Boolean(res.isError) && !text.includes("UNIQUE constraint") && text.includes("already exists");
  } catch (err) {
    const msg = (err as Error).message;
    cleanReject = !msg.includes("UNIQUE constraint") && msg.includes("already exists");
  }
  if (!cleanReject) {
    throw new Error("update_memory: 重复 content 未返回干净错误");
  }
  const still = await client.callTool({ name: "get_memory_by_id", arguments: { id: idB } });
  if (!(still.content as any)[0].text.includes("dup-b")) {
    throw new Error("update_memory: 失败的更新不应改变原内容");
  }
  console.log(`  已干净拒绝, 原内容未变 (id ${idB})`);

  console.log("\n=== Test: export_data 仅 offset 应对三类数据一致生效 ===");
  const offProj = "offset-test";
  for (let i = 0; i < 3; i++) {
    await client.callTool({ name: "record_conversation", arguments: { role: "user", content: `off-c${i}`, project: offProj } });
    await client.callTool({ name: "add_memory", arguments: { type: "context", content: `off-m${i}`, project: offProj } });
  }
  const offRes = await client.callTool({ name: "export_data", arguments: { project: offProj, offset: 1 } });
  const offData = JSON.parse((offRes.content as any)[0].text);
  if (offData.conversations.length !== 2 || offData.memories.length !== 2) {
    throw new Error(`export_data offset=1: 期望 conversations=2 memories=2, 实际 conversations=${offData.conversations.length} memories=${offData.memories.length}`);
  }
  console.log(`  offset=1: conversations ${offData.conversations.length}, memories ${offData.memories.length}, 一致`);

  console.log("\n=== Test: primary_file_types 不应把无点文件当扩展名 ===");
  const extDir = path.join(testDir, "watch-ext");
  fs.mkdirSync(extDir, { recursive: true });
  const extProj = "watch-ext-test";
  await client.callTool({ name: "start_file_watching", arguments: { path: extDir, project: extProj } });
  fs.writeFileSync(path.join(extDir, "data.txt"), "x");
  fs.writeFileSync(path.join(extDir, "Makefile"), "all:");
  await new Promise((r) => setTimeout(r, 1500));
  await client.callTool({ name: "stop_file_watching", arguments: {} });
  await client.callTool({ name: "refresh_profile", arguments: { project: extProj } });
  const pmRes = await client.callTool({ name: "get_memories", arguments: { project: extProj, type: "pattern" } });
  const patterns = JSON.parse((pmRes.content as any)[0].text) as any[];
  const pft = patterns.find((m) => String(m.content).startsWith("primary_file_types:"));
  if (!pft) throw new Error("未生成 primary_file_types 记忆");
  if (pft.content.includes("Makefile")) {
    throw new Error(`无点文件被当成扩展名: ${pft.content}`);
  }
  console.log(`  ${pft.content}`);

  console.log("\n=== Test: search_memories 相关度排序 + 分页 ===");
  const rankProj = "search-rank";
  // A: 命中 3 次、低置信、较旧；B: 命中 1 次、高置信、较新
  await client.callTool({ name: "add_memory", arguments: { type: "context", content: "kw kw kw alpha", confidence: 0.1, project: rankProj } });
  await new Promise((r) => setTimeout(r, 5));
  await client.callTool({ name: "add_memory", arguments: { type: "context", content: "kw beta", confidence: 0.9, project: rankProj } });

  const relRes = await client.callTool({ name: "search_memories", arguments: { query: "kw", project: rankProj } });
  const rel = JSON.parse((relRes.content as any)[0].text) as any[];
  if (rel[0]?.content !== "kw kw kw alpha" || rel[1]?.content !== "kw beta") {
    throw new Error(`相关度排序错误: ${rel.map((m) => m.content).join(" | ")}`);
  }
  console.log("  relevance 排序: 多次命中优先");

  const recRes = await client.callTool({ name: "search_memories", arguments: { query: "kw", project: rankProj, sort: "recent" } });
  const rec = JSON.parse((recRes.content as any)[0].text) as any[];
  if (rec[0]?.content !== "kw beta") {
    throw new Error(`sort=recent 应按时间倒序: ${rec.map((m) => m.content).join(" | ")}`);
  }
  console.log("  sort=recent: 时间倒序");

  const sOffRes = await client.callTool({ name: "search_memories", arguments: { query: "kw", project: rankProj, offset: 1 } });
  const sOff = JSON.parse((sOffRes.content as any)[0].text) as any[];
  if (sOff.length !== 1 || sOff[0]?.content !== "kw beta") {
    throw new Error(`offset=1 应跳过首位: ${sOff.map((m) => m.content).join(" | ")}`);
  }
  console.log("  offset=1: 跳过分页正确");

  for (const bad of [{ sort: "bogus" }, { offset: 1.5 }]) {
    let ok = false;
    try {
      const res = await client.callTool({ name: "search_memories", arguments: { query: "kw", project: rankProj, ...bad } });
      const key = "sort" in bad ? "Invalid sort" : "Invalid offset";
      ok = Boolean(res.isError) && ((res.content as any)[0]?.text ?? "").includes(key);
    } catch (err) {
      const key = "sort" in bad ? "Invalid sort" : "Invalid offset";
      ok = (err as Error).message.includes(key);
    }
    if (!ok) throw new Error(`search_memories ${JSON.stringify(bad)}: 非法参数未被拒绝`);
    console.log(`  ${JSON.stringify(bad)}: 已拒绝`);
  }

  await client.close();
  console.log("\n=== All tests passed! ===");
  
  // 清理测试目录
  fs.rmSync(testDir, { recursive: true, force: true });
}

main().catch(console.error);
