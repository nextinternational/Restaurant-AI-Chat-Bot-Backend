import { Router } from "express";
import type { Logger } from "pino";

export type ReadinessCheck = { name: string; check: () => Promise<void> };

export function healthRouter(checks: ReadinessCheck[], logger: Logger): Router {
  const router = Router();

  // Liveness: the process is up. Used by the container orchestrator to restart a hung process.
  router.get("/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: dependencies are reachable. Used by the AWS ALB to route traffic.
  // Returns no internal details to the public.
  router.get("/ready", async (_req, res) => {
    const results = await Promise.allSettled(checks.map((c) => c.check()));
    const failed = checks.filter((_, i) => results.at(i)?.status === "rejected").map((c) => c.name);
    if (failed.length > 0) {
      logger.error({ failed }, "readiness check failed");
      res.status(503).json({ status: "unavailable" });
      return;
    }
    res.json({ status: "ok" });
  });

  return router;
}
