import type { Logger } from "pino";
import type { Env } from "../config/env.js";
import { AppError } from "../errors.js";
import type { Role } from "../auth/permissions.js";
import { restaurantSlug } from "../domain/slug.js";
import { generatePrefixedId, generateSessionToken, hashToken } from "../security/tokens.js";
import { dummyPasswordHash, hashPasswordAsync, verifyPasswordAsync } from "../security/passwords.js";
import { parseRestaurantId } from "../domain/ids.js";
import { EmailTakenError, type AccountStore } from "../repositories/accountStore.js";

export interface SignupInput {
  email: string;
  password: string;
  name: string;
  restaurantName: string;
  timezone: string;
  currency: string;
}

export interface SessionUser {
  userId: string;
  email: string;
  name: string;
}

export interface RestaurantAccess {
  restaurantId: string;
  name: string;
  slug: string;
  role: Role;
}

export interface AuthResult {
  token: string;
  expiresAt: Date;
  user: SessionUser;
  restaurants: RestaurantAccess[];
}

export interface AuthContext {
  userId: string;
  tokenHash: string;
}

type AuthEnv = Pick<Env, "SESSION_TTL_HOURS" | "TRIAL_DAYS" | "DEFAULT_PLAN_CODE">;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const TOUCH_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

const invalidCredentials = () => new AppError(401, "invalid_credentials", "Invalid email or password");
const unauthenticated = () => new AppError(401, "unauthenticated", "Authentication required");

export class AuthService {
  constructor(
    private readonly store: AccountStore,
    private readonly env: AuthEnv,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Self-service onboarding: user + restaurant (tenant) + owner membership + trial subscription. */
  async signup(input: SignupInput): Promise<AuthResult> {
    const plan = await this.store.getPlan(this.env.DEFAULT_PLAN_CODE);
    if (!plan?.active) {
      this.logger.error({ planCode: this.env.DEFAULT_PLAN_CODE }, "default plan missing or inactive (run db:migrate)");
      throw new AppError(503, "signup_unavailable", "Signup is temporarily unavailable");
    }

    const now = this.clock();
    const passwordHash = await hashPasswordAsync(input.password);
    const userId = generatePrefixedId("usr_");
    const restaurantId = parseRestaurantId(generatePrefixedId("rest_"));
    const slug = restaurantSlug(input.restaurantName);
    const trialMs = (this.env.TRIAL_DAYS > 0 ? this.env.TRIAL_DAYS : 30) * DAY_MS;

    try {
      await this.store.createAccount({
        user: { userId, email: input.email, name: input.name, passwordHash, status: "active", createdAt: now, updatedAt: now },
        restaurant: {
          restaurantId, slug, name: input.restaurantName, status: "active",
          timezone: input.timezone, currency: input.currency, defaultLocale: "en", retention: {},
          monthlyAiBudgetMicros: plan.monthlyAiBudgetMicros, createdAt: now, updatedAt: now,
        },
        membership: { userId, restaurantId, role: "owner", status: "active", createdAt: now, updatedAt: now },
        subscription: {
          restaurantId, planCode: plan.code, status: this.env.TRIAL_DAYS > 0 ? "trialing" : "active",
          currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + trialMs),
          provider: "manual", createdAt: now, updatedAt: now,
        },
      });
    } catch (err) {
      if (err instanceof EmailTakenError) throw new AppError(409, "email_taken", "An account with this email already exists");
      throw err;
    }

    try {
      await this.store.recordAudit(
        restaurantId,
        { actorUserId: userId, action: "restaurant.created", resourceType: "restaurant", resourceId: restaurantId, metadata: { planCode: plan.code } },
        now,
      );
    } catch (err) {
      // The account exists; losing one audit line must not turn a successful signup into an error.
      this.logger.error({ err, restaurantId }, "failed to write signup audit log");
    }

    const user = { userId, email: input.email, name: input.name };
    const session = await this.openSession(userId);
    return { ...session, user, restaurants: [{ restaurantId, name: input.restaurantName, slug, role: "owner" }] };
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.store.findUserByEmail(email);
    // Unknown email still pays for one scrypt: response time must not reveal whether an account exists.
    const ok = await verifyPasswordAsync(password, user?.passwordHash ?? (await dummyPasswordHash()));
    if (!user || !ok) throw invalidCredentials();
    if (user.status === "suspended") throw new AppError(403, "account_suspended", "This account is suspended");
    if (user.status !== "active") throw new AppError(403, "account_pending", "This account is not active yet");

    const session = await this.openSession(user.userId);
    return { ...session, user: { userId: user.userId, email: user.email, name: user.name }, restaurants: await this.restaurantsFor(user.userId) };
  }

  /** Resolves a bearer token to a live session. Every failure mode returns the same 401. */
  async authenticate(token: string | undefined): Promise<AuthContext> {
    if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) throw unauthenticated();
    const tokenHash = hashToken(token);
    const session = await this.store.findSessionByTokenHash(tokenHash);
    const now = this.clock();
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now.getTime()) throw unauthenticated();

    const user = await this.store.findUserById(session.userId);
    if (user?.status !== "active") throw unauthenticated(); // suspending a user kills access immediately

    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.store.touchSession(tokenHash, now).catch((err: unknown) => this.logger.warn({ err }, "session touch failed"));
    }
    return { userId: user.userId, tokenHash };
  }

  async me(userId: string): Promise<{ user: SessionUser; restaurants: RestaurantAccess[] }> {
    const user = await this.store.findUserById(userId);
    if (!user) throw unauthenticated();
    return { user: { userId: user.userId, email: user.email, name: user.name }, restaurants: await this.restaurantsFor(userId) };
  }

  async logout(tokenHash: string): Promise<void> {
    await this.store.revokeSession(tokenHash, this.clock());
  }

  async logoutEverywhere(userId: string): Promise<void> {
    await this.store.revokeAllSessions(userId, this.clock());
  }

  // ------------------------------------------------------------------ internals
  private async openSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const now = this.clock();
    const token = generateSessionToken();
    const expiresAt = new Date(now.getTime() + this.env.SESSION_TTL_HOURS * 3_600_000);
    // Only the SHA-256 of the token is stored: a database leak does not leak usable sessions.
    await this.store.createSession({ userId, tokenHash: hashToken(token), createdAt: now, lastSeenAt: now, expiresAt });
    return { token, expiresAt };
  }

  private async restaurantsFor(userId: string): Promise<RestaurantAccess[]> {
    const rows = await this.store.listMembershipsForUser(userId);
    return rows
      .filter((r) => r.restaurant.status === "active")
      .map((r) => ({ restaurantId: r.restaurant.restaurantId, name: r.restaurant.name, slug: r.restaurant.slug, role: r.membership.role }));
  }
}
