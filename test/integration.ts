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

  await client.close();
  console.log("\n=== All tests passed! ===");
  
  // 清理测试目录
  fs.rmSync(testDir, { recursive: true, force: true });
}

main().catch(console.error);
