declare global {
  namespace Express {
    interface Request {
      id: string;
      /** Set by `authenticate`: the logged-in restaurant user and their session. */
      auth?: { userId: string; tokenHash: string };
      /** Set by `requireTenant`: the tenant the server verified this user belongs to, and their role there. */
      tenant?: { restaurantId: import("../domain/ids.js").RestaurantId; role: import("../auth/permissions.js").Role; userId: string };
    }
  }
}
export {};
