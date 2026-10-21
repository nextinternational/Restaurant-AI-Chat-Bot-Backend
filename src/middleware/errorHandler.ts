import type { ErrorRequestHandler, RequestHandler } from "express";
import type { Logger } from "pino";
import { AppError } from "../errors.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "Resource not found", requestId: req.id } });
};

const BAD_REQUEST = { code: "bad_request", message: "Malformed request" };
const CLIENT_ERRORS = new Map<number, { code: string; message: string }>([
  [400, BAD_REQUEST],
  [413, { code: "payload_too_large", message: "Request body too large" }],
  [415, { code: "unsupported_media_type", message: "Unsupported media type" }],
]);

/** Never leaks stack traces or internals to clients. */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  // Express identifies error handlers by arity (4 args), so `next` must stay in the signature.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err, req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: { code: err.code, message: err.message, requestId: req.id } });
      return;
    }
    // Body-parser errors carry a 4xx `status`; map known ones, collapse any other 4xx to a generic 400.
    const status = typeof err?.status === "number" ? err.status : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      const mapped = CLIENT_ERRORS.get(status);
      res.status(mapped ? status : 400).json({ error: { ...(mapped ?? BAD_REQUEST), requestId: req.id } });
      return;
    }
    logger.error({ err, requestId: req.id }, "unhandled error");
    res.status(500).json({ error: { code: "internal_error", message: "Internal server error", requestId: req.id } });
  };
}
