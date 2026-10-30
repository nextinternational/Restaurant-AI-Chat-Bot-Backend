import type { Collections } from "../db/collections.js";
import { ScopedCollection } from "../db/scopedCollection.js";
import type { RestaurantId } from "../domain/ids.js";
import { openingHoursSchema, type OpeningHours } from "../domain/schemas.js";

export class HoursRepository {
  private readonly hours: ScopedCollection<OpeningHours>;
  constructor(cols: Collections, restaurantId: RestaurantId) {
    this.hours = new ScopedCollection(cols.openingHours, restaurantId);
  }

  get(): Promise<OpeningHours | null> {
    return this.hours.findOne({});
  }

  async replace(input: Pick<OpeningHours, "weekly" | "exceptions">, now = new Date()): Promise<void> {
    const doc = openingHoursSchema.parse({ ...input, restaurantId: this.hours.restaurantId, updatedAt: now });
    await this.hours.updateOne({}, { $set: { weekly: doc.weekly, exceptions: doc.exceptions, updatedAt: now } }, { upsert: true });
  }
}
