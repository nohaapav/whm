import type { FastifyInstance } from "fastify";

import { getOrder, getQuote, listOrders, listQuotes } from "./db";
import { tokenMetadata } from "./metadata";

/** Register the intents read API. Orders and quotes are separate tables under one domain. */
export function routes(app: FastifyInstance): void {
  // Static path, registered before `/:id` so a sequence lookup never captures it.
  app.get("/api/tokens", async () => tokenMetadata());

  app.get<{
    Querystring: { state?: string; address?: string; limit?: string; offset?: string };
  }>("/api/orders", async (req) => {
    const q = req.query;
    return listOrders({
      state: q.state,
      address: q.address,
      limit: Math.min(Number(q.limit ?? 100), 1000),
      offset: Number(q.offset ?? 0),
    });
  });

  app.get<{ Params: { id: string } }>("/api/orders/:id", async (req, reply) => {
    const row = await getOrder(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return row;
  });

  app.get<{ Querystring: { limit?: string; offset?: string } }>("/api/quotes", async (req) =>
    listQuotes(Math.min(Number(req.query.limit ?? 100), 1000), Number(req.query.offset ?? 0)),
  );

  app.get<{ Params: { id: string } }>("/api/quotes/:id", async (req, reply) => {
    const row = await getQuote(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return row;
  });
}
