import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { gameTools } from './tools.mjs';
import { explainError } from './errors.mjs';

export async function createMcp(options, { invoke } = {}) {
  const server = new McpServer({ name: 'digital-matter-world', version: '0.1.0' });
  let tail = Promise.resolve();
  for (const [name, tool] of Object.entries(gameTools(options))) server.registerTool(name, {
    description: tool.description, inputSchema: tool.schema,
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly, openWorldHint: !tool.readOnly, idempotentHint: tool.readOnly }
  }, (args, extra) => {
    const result = tail.then(async () => {
      try { const value = await (invoke ? invoke(name, args, extra) : tool.run(args, extra)); return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: explainError(error) }] }; }
    });
    tail = result.then(() => {});
    return result;
  });
  return server;
}
export async function serveMcp(options, forwarding) { const server = await createMcp(options, forwarding); await server.connect(new StdioServerTransport()); return server; }
