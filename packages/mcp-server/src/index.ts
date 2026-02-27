import { and, eq } from 'drizzle-orm';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Database } from '@shopify-agent-channel/db';
import { manifests } from '@shopify-agent-channel/db';
import type { AgentsJson } from '@shopify-agent-channel/manifest';
import type { ExecutionRouter } from '@shopify-agent-channel/exec';
import { registerTools } from './registerTools.js';

export { registerTools } from './registerTools.js';

export async function createMCPServer(config: {
  shopId: string;
  db: Database;
  router: ExecutionRouter;
}): Promise<Server> {
  const { shopId, db, router } = config;

  const manifest = await db.query.manifests.findFirst({
    where: and(eq(manifests.shopId, shopId), eq(manifests.isActive, true)),
  });

  if (!manifest) {
    throw new Error(`No active manifest found for shop ${shopId}`);
  }

  const agentsJson = manifest.agentsJson as AgentsJson;

  const server = new Server(
    { name: agentsJson.name, version: agentsJson.version },
    { capabilities: { tools: {} } },
  );

  registerTools(server, agentsJson, shopId, router);

  return server;
}
