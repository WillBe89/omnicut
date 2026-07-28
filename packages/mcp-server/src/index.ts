#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProjectStore } from "./store.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const store = new ProjectStore();
  const server = createServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so we don't corrupt the stdio JSON-RPC channel.
  process.stderr.write(`[video-editor-mcp] ready. Project store: ${store.home}\n`);
}

main().catch((err) => {
  process.stderr.write(`[video-editor-mcp] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
