// Explicitly scoped QA cart/wishlist capability. Catalog provenance stays simulated.
export const QA_COMMERCE_DATABASE = "toss_v4_qa_commerce_20261019";
export const QA_COMMERCE_ROLE = "commerce_v4_qa";
export function qaCommerceEnabled(env: Record<string, string | undefined>): boolean {
  if (env.QA_COMMERCE_ENABLED === undefined || env.QA_COMMERCE_ENABLED === "0") return false;
  if (env.QA_COMMERCE_ENABLED !== "1" || env.QA_AUTH_ENABLED !== "1" ||
      env.COMMERCE_CATALOG_SOURCE !== "test_items") throw Error("invalid QA Commerce configuration");
  const u = new URL(env.DATABASE_URL ?? "");
  if (u.hostname !== "127.0.0.1" || u.port !== "15440" ||
      u.pathname !== "/" + QA_COMMERCE_DATABASE || decodeURIComponent(u.username) !== QA_COMMERCE_ROLE || u.search)
    throw Error("QA Commerce requires the dedicated local database and role");
  return true;
}
export function qaCommerceRequestAllowed(method: string, path: string): boolean {
  return (method === "GET" && ["/api/cart", "/api/wishlist", "/api/actions"].includes(path)) ||
    (method === "GET" && /^\/api\/actions\/[^/]+$/.test(path)) ||
    (method === "POST" && path === "/api/cart/items") ||
    (["PATCH", "DELETE"].includes(method) && /^\/api\/cart\/items\/[^/]+$/.test(path)) ||
    (method === "PUT" && /^\/api\/wishlist\/[^/]+$/.test(path));
}
