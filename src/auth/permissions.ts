/**
 * Central permission map. Controllers ask `can(role, "menu:write")`; they never compare role strings.
 * Adding a role or moving a permission is a one-line change here.
 */
export const ROLES = ["owner", "admin", "manager", "staff", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "restaurant:read", "restaurant:write",
  "menu:read", "menu:write",
  "hours:read", "hours:write",
  /** FAQs and policies the assistant may quote once published. */
  "knowledge:read", "knowledge:write",
  /** Attesting that an allergen declaration was checked against the recipe. Deliberately separate from menu:write. */
  "allergens:verify",
  "team:read", "team:manage",
  "billing:read", "billing:manage",
  "widgets:manage",
  "audit:read",
  "usage:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

const ROLE_PERMISSIONS: ReadonlyMap<Role, ReadonlySet<Permission>> = new Map<Role, ReadonlySet<Permission>>([
  ["owner", new Set(ALL)],
  ["admin", new Set(ALL.filter((p) => p !== "billing:manage"))],
  ["manager", new Set<Permission>([
    "restaurant:read", "menu:read", "menu:write", "hours:read", "hours:write", "allergens:verify",
    "knowledge:read", "knowledge:write", "team:read", "usage:read",
  ])],
  ["staff", new Set<Permission>(["restaurant:read", "menu:read", "hours:read", "knowledge:read"])],
  ["viewer", new Set<Permission>(["restaurant:read", "menu:read", "hours:read", "knowledge:read", "usage:read"])],
]);

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS.get(role)?.has(permission) ?? false;
}
