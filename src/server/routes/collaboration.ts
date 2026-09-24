import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { currentUser } from "../auth.js";
import type { CollaborationService } from "../collaboration.js";
import type { DatabaseConnection } from "../db.js";
import type { MetricRegistry } from "../metrics.js";
import type { Config } from "../config.js";
import { hasOwnRequestOrigin, iframeLoginEnabled } from "../iframeLogin.js";

interface CollaborationRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  metrics: MetricRegistry;
}

/** Register the project-scoped WebSocket endpoint used for live editing. */
export function registerCollaborationRoutes(app: FastifyInstance, context: CollaborationRouteContext): void {
  const { config, db, collaboration, metrics } = context;

  app.get("/api/collaboration/:id", { websocket: true }, async (socket, request) => {
    if (iframeLoginEnabled(config) && !hasOwnRequestOrigin(request)) {
      socket.close(1008, "Invalid WebSocket origin");
      return;
    }
    const user = await currentUser(request, db);
    if (!user) {
      socket.close(1008, "Authentication required");
      return;
    }
    const { id } = request.params as { id: string };
    const startedAt = performance.now();
    void collaboration.connect(socket, id, user)
      .finally(() => metrics.record("collaboration.connect", performance.now() - startedAt));
  });
}
