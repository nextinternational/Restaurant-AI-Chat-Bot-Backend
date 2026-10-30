import { AppError } from "../../errors.js";
import type { RestaurantId } from "../../domain/ids.js";
import type { ConversationUsage, ModelUsageTotals, UsageTotals } from "../../repositories/usageRepository.js";
import type { UsageGateway } from "./gateway.js";

export interface UsageReport {
  period: { from: Date; to: Date };
  totals: UsageTotals;
  /** The restaurant's own monthly AI budget in micro-USD; 0 means the platform default applies. */
  monthlyBudgetMicros: number;
  byModel: ModelUsageTotals[];
  topConversations: ConversationUsage[];
}

/** Spec section 12: what the assistant really costs, per restaurant, per model and per conversation. */
export class UsageAdminService {
  constructor(
    private readonly gateway: UsageGateway,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** `restaurantId` must already be the server-verified one (after `requireTenant`). Defaults to the current UTC month. */
  async report(restaurantId: RestaurantId, range: { from?: Date | undefined; to?: Date | undefined; limit: number }): Promise<UsageReport> {
    const ctx = await this.gateway.tenantContext(restaurantId);
    if (!ctx) throw new AppError(404, "not_found", "Resource not found");
    const now = this.clock();
    const from = range.from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = range.to ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    if (from >= to) throw new AppError(400, "invalid_input", "`from` must be earlier than `to`");
    const [totals, byModel, topConversations] = await Promise.all([
      ctx.usage.totals(from, to),
      ctx.usage.byModel(from, to),
      ctx.usage.topConversations(from, to, range.limit),
    ]);
    return { period: { from, to }, totals, monthlyBudgetMicros: ctx.restaurant.monthlyAiBudgetMicros, byModel, topConversations };
  }
}
