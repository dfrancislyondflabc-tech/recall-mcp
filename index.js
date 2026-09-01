#!/usr/bin/env node

// recall-mcp — two-tier hybrid retrieval over Claude's persistent memory.
//
// IMPORTANT: Use console.error() for logging, NOT console.log().
// stdout is reserved for JSON-RPC protocol messages. Any stray stdout output
// will corrupt the protocol and crash Claude Desktop.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { log, error } from './lib/logger.js';
import { registerMemoryTools } from './tools/memory.js';
import { memoryDir, indexPath } from './lib/config.js';
import { versionBanner, serverVersionString } from './lib/version.js';

// ---- Graceful signal handling ----
// Prevents a Claude Desktop crash on disconnect or kill.
process.on('SIGPIPE', () => { /* ignore — the client closed the pipe */ });
process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  error('Uncaught exception:', err.message);
  // DON'T exit — let the MCP SDK handle recovery.
});
process.on('unhandledRejection', (reason) => {
  error('Unhandled rejection:', reason);
  // DON'T exit — let the MCP SDK handle recovery.
});

const server = new McpServer({
  name: 'recall-mcp',
  version: '1.1.0'
});

registerMemoryTools(server);

async function main() {
  // WHICH BUILD IS ANSWERING — logged before the transport, so it is the first
  // line in the log even if the connect fails. Node caches every module at
  // spawn, so a client that was launched this morning is still running this
  // morning's code; without this line that is invisible, and on 2026-08-19 it
  // cost a session an afternoon. stderr only: stdout is the JSON-RPC channel.
  log(versionBanner());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`Connected — ${serverVersionString()} (1 tool: memory). corpus=${memoryDir()} index=${indexPath()}`);
}

main().catch((e) => {
  error('Fatal:', e);
  process.exit(1);
});
