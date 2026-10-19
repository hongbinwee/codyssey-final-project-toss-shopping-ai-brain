// Explicitly scoped QA cart/wishlist capability. Catalog provenance stays simulated.
export const QA_COMMERCE_DATABASE = "toss_v4_qa_commerce_20261019";
export const QA_COMMERCE_ROLE = "commerce_v4_qa";
export function qaCommerceIdentity(env:Record<string,string|undefined>){
  return env.COMMERCE_CATALOG_SOURCE==="test_items2"
    ?{database:"toss_test_items2_qa_20261019",role:"commerce_t2_qa",brainDatabase:env.QA_REUSE_EXISTING_BRAIN==="1"?"brain_shopping_v4_20261018_w01":"brain_test_items2_qa_20261019",brainRole:env.QA_REUSE_EXISTING_BRAIN==="1"?"brain_v4_service":"brain_t2_qa"}
    :{database:QA_COMMERCE_DATABASE,role:QA_COMMERCE_ROLE,brainDatabase:"brain_shopping_v4_20261018_w01",brainRole:"brain_v4_service"};
}
export function qaCommerceEnabled(env: Record<string, string | undefined>): boolean {
  if (env.QA_COMMERCE_ENABLED === undefined || env.QA_COMMERCE_ENABLED === "0") return false;
  if (env.QA_COMMERCE_ENABLED !== "1" || env.QA_AUTH_ENABLED !== "1" ||
      !["test_items","test_items2"].includes(env.COMMERCE_CATALOG_SOURCE??"")) throw Error("invalid QA Commerce configuration");
  const identity=qaCommerceIdentity(env);
  const u = new URL(env.DATABASE_URL ?? "");
  if (u.hostname !== "127.0.0.1" || u.port !== "15440" ||
      u.pathname !== "/" + identity.database || decodeURIComponent(u.username) !== identity.role || u.search)
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
