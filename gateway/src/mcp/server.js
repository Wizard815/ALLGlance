// MCP server wrapper — exposes the AllGLANCE gateway as a Model Context Protocol
// server (DESIGN.md §6), modeled on vikunja's built-in MCP at /api/v2/mcp.
//
// This is the single front door for MCP clients (Claude, editors, Home
// Assistant). It wires the gateway's tools + REST routes onto a real MCP
// server instance, so adding an app = adding an adapter = the tools appear.

import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Build an AllGLANCE MCP server backed by a Gateway instance.
 * @param {import('./gateway.js').Gateway} gateway
 * @param {object} [opts]
 * @param {string} [opts.name='allglance']
 * @param {string} [opts.version='0.1.0']
 */
export function createAllglanceMcpServer(gateway, opts = {}) {
  const { name = 'allglance', version = '0.1.0' } = opts;

  const server = new Server(
    { name, version },
    { capabilities: { tools: {} } }
  );

  // Collect the tool metadata so the server can list + dispatch them.
  const tools = gateway.registerMcpTools({
    addTool: () => {},
    registerTool: () => {},
  });

  const dynamic = async () => (typeof gateway.dynamicMcpTools === 'function' ? gateway.dynamicMcpTools() : []);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools, ...(await dynamic())].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;
    const matched = tools.find((t) => t.name === toolName) ?? (await dynamic()).find((t) => t.name === toolName);
    if (!matched) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }
    try {
      return await matched.handler(args ?? {});
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return { server, tools };
}

/**
 * Serve the MCP server over Streamable HTTP (the transport the MCP spec uses,
 * and what vikunja's native MCP exposes). Returns an Express router that the
 * gateway can mount.
 *
 * STATELESS: a fresh server + transport per request. The tools hold no
 * per-client state, and a single shared stateful transport accepts exactly one
 * `initialize` for the life of the process, so every later client (any agent
 * reconnecting) was refused until the container restarted.
 */
export function createMcpRouter(gateway) {
  const router = express.Router();
  router.use(express.json());

  router.post('/mcp', async (req, res) => {
    try {
      const { server } = createAllglanceMcpServer(gateway);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null });
      }
    }
  });

  // Stateless: there is no session to stream to or to end.
  const notSupported = (_req, res) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP endpoint is stateless, POST only' }, id: null });
  router.get('/mcp', notSupported);
  router.delete('/mcp', notSupported);

  return router;
}

export default createAllglanceMcpServer;
