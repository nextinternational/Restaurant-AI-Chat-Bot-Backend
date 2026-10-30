import { z } from "zod";

declare const brand: unique symbol;
/**
 * A tenant identifier that has been validated. Because it is a branded type, a plain `string`
 * (for example something taken from a request body or produced by the AI) cannot be passed where a
 * RestaurantId is required: it must go through `parseRestaurantId`, which only the server calls
 * after resolving the tenant itself.
 */
export type RestaurantId = string & { readonly [brand]: "RestaurantId" };

const RESTAURANT_ID = /^rest_[a-z0-9]{1,32}$/;

export const restaurantIdSchema = z
  .string()
  .regex(RESTAURANT_ID, "invalid restaurantId")
  .transform((v) => v as RestaurantId);

export function parseRestaurantId(value: unknown): RestaurantId {
  return restaurantIdSchema.parse(value);
}
