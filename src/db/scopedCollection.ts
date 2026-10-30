import type {
  AggregateOptions, Collection, Document, Filter, FindOptions, OptionalUnlessRequiredId,
  UpdateFilter, UpdateOptions, WithId,
} from "mongodb";
import type { RestaurantId } from "../domain/ids.js";
import { AppError } from "../errors.js";

/**
 * TENANT ISOLATION ENFORCED BY CODE, NOT BY CONVENTION.
 *
 * Every read and write to a tenant-owned collection goes through a ScopedCollection bound to ONE
 * restaurantId. The id is injected here; callers cannot supply, override or omit it, and neither can
 * the AI model. Combined with an ESLint rule that forbids `db.collection()` outside `src/db`, there is
 * no supported way to write an unscoped query.
 */
type TenantDoc = { restaurantId: RestaurantId };

/** Operators that execute JavaScript on the server or read other collections (cross-tenant leaks). */
const FORBIDDEN_OPERATORS = new Set([
  "$where", "$function", "$accumulator", "$lookup", "$graphLookup", "$unionWith", "$out", "$merge",
  "$currentOp", "$listSessions", "$collStats", "$indexStats",
]);
const MAX_DEPTH = 12;
export const MAX_PAGE_SIZE = 100;

function assertSafe(value: unknown, depth = 0, topLevelFilter = false): void {
  if (depth > MAX_DEPTH) throw new AppError(400, "bad_query", "Query too deeply nested");
  if (Array.isArray(value)) {
    for (const v of value) assertSafe(v, depth + 1);
    return;
  }
  if (value === null || typeof value !== "object" || value instanceof Date) return;
  if ("_bsontype" in value) return; // ObjectId, Decimal128, ...
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_OPERATORS.has(key)) throw new AppError(400, "bad_query", `Operator ${key} is not allowed`);
    if (topLevelFilter && key === "restaurantId") {
      throw new AppError(500, "tenant_violation", "restaurantId must not be supplied by callers");
    }
    assertSafe(child, depth + 1);
  }
}

function assertNoTenantMutation(update: Record<string, unknown>): void {
  for (const [op, fields] of Object.entries(update)) {
    if (!op.startsWith("$")) throw new AppError(500, "bad_update", "Replacement documents are not allowed");
    if (op === "$rename") throw new AppError(500, "bad_update", "$rename is not allowed");
    if (fields && typeof fields === "object" && "restaurantId" in fields) {
      throw new AppError(500, "tenant_violation", "restaurantId is immutable");
    }
  }
  assertSafe(update);
}

export class ScopedCollection<T extends TenantDoc> {
  constructor(
    private readonly col: Collection<T>,
    readonly restaurantId: RestaurantId,
  ) {}

  private scope(filter: Filter<T> | undefined): Filter<T> {
    if (filter) assertSafe(filter, 0, true);
    // `$and` keeps the tenant predicate separate from anything in `filter`, whatever it contains.
    return { $and: [{ restaurantId: this.restaurantId }, filter ?? {}] } as unknown as Filter<T>;
  }

  findOne(filter: Filter<T>, options?: FindOptions): Promise<WithId<T> | null> {
    return this.col.findOne(this.scope(filter), options);
  }

  /** `limit` is mandatory: unbounded reads are a DoS and a data-exfiltration risk. */
  find(filter: Filter<T>, options: FindOptions & { limit: number }): Promise<WithId<T>[]> {
    const limit = Math.min(Math.max(1, Math.trunc(options.limit)), MAX_PAGE_SIZE);
    return this.col.find(this.scope(filter), { ...options, limit }).toArray();
  }

  async insertOne(doc: Omit<T, "restaurantId" | "_id">) {
    assertSafe(doc, 0, true);
    const full = { ...doc, restaurantId: this.restaurantId } as unknown as OptionalUnlessRequiredId<T>;
    return this.col.insertOne(full);
  }

  updateOne(filter: Filter<T>, update: UpdateFilter<T>, options?: UpdateOptions) {
    assertNoTenantMutation(update as Record<string, unknown>);
    const upsertGuard =
      options?.upsert === true
        ? { ...update, $setOnInsert: { ...(update.$setOnInsert as object | undefined), restaurantId: this.restaurantId } }
        : update;
    return this.col.updateOne(this.scope(filter), upsertGuard as UpdateFilter<T>, options);
  }

  countDocuments(filter: Filter<T>) {
    return this.col.countDocuments(this.scope(filter));
  }

  /** The tenant `$match` is always the first stage; stages that can read other collections are rejected. */
  aggregate<R extends Document = Document>(pipeline: Document[], options?: AggregateOptions): Promise<R[]> {
    assertSafe(pipeline);
    const scoped = [{ $match: { restaurantId: this.restaurantId } }, ...pipeline];
    return this.col.aggregate<R>(scoped, options).toArray();
  }
}
