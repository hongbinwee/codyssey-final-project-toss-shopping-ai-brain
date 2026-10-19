import type postgres from "postgres";
import type {CommerceActivity} from "./recommendation-strategies.ts";
type ReadonlySql=Pick<ReturnType<typeof postgres>,"unsafe">;
/** Only authenticated actor IDs are supplied by Brain. Never read another user's rows. */
export async function readCommerceActivity(db:ReadonlySql,actorUserId:string):Promise<CommerceActivity>{
 if(!actorUserId||actorUserId.length>256)throw Error("invalid activity actor");
 // Fail closed to empty activity on missing demo-only tables; do not block the
 // user's explicit request or substitute records from a different actor.
 const [wish,cart]=await Promise.all([
  db.unsafe<Array<{product_id:string}>>(
   "SELECT product_id FROM wishlist_items WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[actorUserId]),
  db.unsafe<Array<{product_id:string}>>(
   "SELECT DISTINCT v.product_id FROM carts c JOIN cart_items i ON i.cart_id=c.id JOIN product_variants v ON v.id=i.variant_id WHERE c.user_id=$1 LIMIT 100",[actorUserId])
 ]);
 return {wishlistProductIds:wish.map(x=>x.product_id),cartProductIds:cart.map(x=>x.product_id)};
}
