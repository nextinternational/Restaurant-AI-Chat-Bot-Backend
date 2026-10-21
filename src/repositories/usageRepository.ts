import type { ObjectId } from "mongodb";
import type { Collections } from "../db/collections.js";
import { ScopedCollection } from "../db/scopedCollection.js";
import { retentionPolicy, type RetentionDefaults } from "../db/retention.js";
import type { RestaurantId } from "../domain/ids.js";
import { usageLogSchema, type Restaurant, type UsageLog } from "../domain/schemas.js";

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicros: number;
}

export interface ConversationUsage extends UsageTotals {
  conversationId: string;
  firstAt: Date;
  lastAt: Date;
}

export interface ModelUsageTotals extends UsageTotals {
  model: string;
}

export class UsageRepository {
  private readonly usage: ScopedCollection<UsageLog>;
  private readonly policy: ReturnType<typeof retentionPolicy>;

  constructor(cols: Collections, restaurantId: RestaurantId, defaults: RetentionDefaults, restaurant?: Pick<Restaurant, "retention">) {
    this.usage = new ScopedCollection(cols.usageLogs, restaurantId);
    this.policy = retentionPolicy(defaults, restaurant);
  }

  async record(
    entry: { conversationId: ObjectId; model: string; inputTokens: number; outputTokens: number; estimatedCostMicros: number },
    now = new Date(),
  ): Promise<void> {
    const doc = usageLogSchema.parse({
      ...entry,
      restaurantId: this.usage.restaurantId,
      createdAt: now,
      expiresAt: this.policy.usageExpiry(now),
    });
    const { restaurantId: _omit, ...rest } = doc;
    void _omit;
    await this.usage.insertOne(rest);
  }

  /** Totals for [from, to) for THIS restaurant only (the tenant $match is injected by ScopedCollection). */
  async totals(from: Date, to: Date): Promise<UsageTotals> {
    const [row] = await this.usage.aggregate<UsageTotals>([
      { $match: { createdAt: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: null,
          requests: { $sum: 1 },
          inputTokens: { $sum: "$inputTokens" },
          outputTokens: { $sum: "$outputTokens" },
          estimatedCostMicros: { $sum: "$estimatedCostMicros" },
        },
      },
      { $project: { _id: 0 } },
    ]);
    return row ?? { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 };
  }

  /** Cost per model for [from, to), so a price change or a model switch is visible. */
  async byModel(from: Date, to: Date): Promise<ModelUsageTotals[]> {
    return this.usage.aggregate<ModelUsageTotals>([
      { $match: { createdAt: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: "$model",
          requests: { $sum: 1 },
          inputTokens: { $sum: "$inputTokens" },
          outputTokens: { $sum: "$outputTokens" },
          estimatedCostMicros: { $sum: "$estimatedCostMicros" },
        },
      },
      { $project: { _id: 0, model: "$_id", requests: 1, inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 } },
      { $sort: { estimatedCostMicros: -1 } },
    ]);
  }

  /** The most expensive conversations in [from, to), for THIS restaurant only. */
  async topConversations(from: Date, to: Date, limit: number): Promise<ConversationUsage[]> {
    const rows = await this.usage.aggregate<Omit<ConversationUsage, "conversationId"> & { _id: ObjectId }>([
      { $match: { createdAt: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: "$conversationId",
          requests: { $sum: 1 },
          inputTokens: { $sum: "$inputTokens" },
          outputTokens: { $sum: "$outputTokens" },
          estimatedCostMicros: { $sum: "$estimatedCostMicros" },
          firstAt: { $min: "$createdAt" },
          lastAt: { $max: "$createdAt" },
        },
      },
      { $sort: { estimatedCostMicros: -1, _id: 1 } },
      { $limit: limit },
    ]);
    return rows.map(({ _id, ...rest }) => ({ conversationId: _id.toHexString(), ...rest }));
  }
}
