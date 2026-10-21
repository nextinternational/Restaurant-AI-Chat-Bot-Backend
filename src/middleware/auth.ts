import type { RequestHandler } from "express";
import { AppError } from "../errors.js";
import { can, type Permission } from "../auth/permissions.js";
import { restaurantIdSchema } from "../domain/ids.js";
import type { AccountStore } from "../repositories/accountStore.js";
import type { AuthService } from "../services/authService.js";

const notFound = () => new AppError(404, "not_found", "Resource not found");

/** `Authorization: Bearer <token>` -> req.auth. Tokens are never accepted from the URL or the body. */
export function authenticate(auth: AuthService): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer ([^\s]+)$/.exec(header) : null;
    req.auth = await auth.authenticate(match?.[1]);
    next();
  };
}

/**
 * The :restaurantId in the URL is only a CLAIM. The server checks the caller has an active membership
 * there and that the role grants `permission`; only then is the tenant bound to the request.
 * Non-members get 404 (not 403) so tenant ids cannot be probed.
 */
export function requireTenant(store: AccountStore, permission: Permission): RequestHandler {
  return async (req, _res, next) => {
    if (!req.auth) throw new AppError(401, "unauthenticated", "Authentication required");
    const raw = req.params.restaurantId;
    const parsed = restaurantIdSchema.safeParse(typeof raw === "string" ? raw : "");
    if (!parsed.success) throw notFound();

    const membership = await store.getMembership(req.auth.userId, parsed.data);
    if (!membership) throw notFound();
    if (!can(membership.role, permission)) throw new AppError(403, "forbidden", "Your role does not allow this action");

    const restaurant = await store.getRestaurant(parsed.data);
    if (!restaurant) throw notFound();
    if (restaurant.status !== "active") throw new AppError(403, "restaurant_suspended", "This restaurant account is suspended");

    req.tenant = { restaurantId: parsed.data, role: membership.role, userId: req.auth.userId };
    next();
  };
}
