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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;
    const matched = tools.find((t) => t.name === toolName);
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
 */
export function createMcpRouter(gateway) {
  const { server } = createAllglanceMcpServer(gateway);
  const router = express.Router();
  let transport = null;

  router.use(express.json());

  router.post('/mcp', async (req, res) => {
    try {
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => `allglance-${Date.now()}`,
        });
        await server.connect(transport);
      }
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/mcp', async (req, res) => {
    if (transport) await transport.handleRequest(req, res);
    else res.status(405).json({ error: 'No active MCP session' });
  });

  router.delete('/mcp', async (req, res) => {
    if (transport) await transport.handleRequest(req, res);
  });

  return router;
}

export default createAllglanceMcpServer;
