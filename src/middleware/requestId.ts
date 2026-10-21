import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

/** Every request gets a server-generated ID (client-supplied IDs are ignored) for log correlation. */
export const requestId: RequestHandler = (req, res, next) => {
  const id = randomUUID();
  req.id = id;
  res.setHeader("X-Request-Id", id);
  next();
};
