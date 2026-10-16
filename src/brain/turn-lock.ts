import {createHash} from "node:crypto";

/** One exclusive turn per conversation across all processes sharing the AI database.
 * Locks are session-scoped and released by postgres.js reserved connection close.
 * Only the AI-owned PostgreSQL pool may be used. Not a Commerce DB tool.
 */
export interface TurnLock {
  tryAcquire(conversationId:string):Promise<null|(()=>Promise<void>)>
}
interface ReservedSession {
  unsafe(query:string,args:unknown[]):Promise<{acquired:boolean}[]>;
  release():Promise<unknown>;
}
interface ReservePool {
  reserve():Promise<ReservedSession>
}
function lockKey(conversationId:string):string {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId))
    throw new Error("invalid conversation id for distributed lock");
  // Domain-separated 64-bit advisory key avoids hashtext's 32-bit collisions.
  const digest=createHash("sha256").update("shopping_brain/turn/v1/").update(conversationId).digest("hex");
  return BigInt.asIntN(64,BigInt("0x"+digest.slice(0,16))).toString();
}
export function postgresTurnLock(pool:ReservePool):TurnLock{
  return {async tryAcquire(conversationId:string){
    const key=lockKey(conversationId);
    const connection=await pool.reserve();
    let acquired=false,released=false;
    try{
      const rows=await connection.unsafe("SELECT pg_try_advisory_lock($1::bigint) AS acquired",[key]);
      acquired=rows.length===1&&rows[0].acquired===true;
      if(!acquired){await connection.release();return null;}
      return async()=>{
        if(released)return;
        released=true;
        try{
          const rows=await connection.unsafe("SELECT pg_advisory_unlock($1::bigint) AS acquired",[key]);
          if(rows.length!==1||rows[0].acquired!==true)
            throw new Error("Brain turn lock was not held at release");
        }finally{
          await connection.release();
        }
      };
    }catch(e){
      if(!acquired)await connection.release().catch(()=>{});
      throw e;
    }
  }};
}
