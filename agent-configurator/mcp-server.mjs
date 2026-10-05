#!/usr/bin/env node
// MCP front door of the agent configurator: every op in lib/ops.mjs is an MCP tool (stdio).
//
//   node mcp-server.mjs        (configure it in Claude Code with .mcp.example.json)
//
// Built on the official @modelcontextprotocol/sdk (MIT, pinned 1.32.0). The low-level `Server` is
// used on purpose: each op's input is a plain JSON Schema that is ALSO what the CLI validates
// against, so both front doors share one definition (McpServer would require re-declaring every
// schema in zod). Tool results are JSON text; failures come back as isError results carrying
// { code, message, details } so the agent can react (fix and retry, ask the human, re-read on conflict).
// stdout belongs to the protocol: nothing else is ever written to it.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createContext, runOp, listOps, SERVER_INSTRUCTIONS } from './lib/ops.mjs';
import { errorPayload } from './lib/errors.mjs';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export function createMcpServer(ctx = createContext()) {
  const server = new Server(
    { name: 'matrix-workspace-configurator', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listOps().map(o => ({
      name: o.name,
      title: o.title,
      description: o.description,
      inputSchema: o.inputSchema,
      annotations: { title: o.title, readOnlyHint: o.readOnly, destructiveHint: o.destructive, openWorldHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const { name, arguments: args } = req.params;
    try {
      const result = await runOp(ctx, name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: errorPayload(e) }, null, 2) }] };
    }
  });
  return server;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  process.on('SIGINT', () => { server.close().finally(() => process.exit(0)); });
}
