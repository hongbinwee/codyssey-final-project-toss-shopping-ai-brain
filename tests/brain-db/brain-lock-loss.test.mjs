import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {postgresTurnLock} from "../../src/brain/turn-lock.ts";

// Safety characterization, NOT an exactly-once guarantee. Uses CI-only brain_ci.
test("killing an advisory-lock backend releases exclusivity while its old worker may still be alive", async () => {
  const url=process.env.BRAIN_DATABASE_URL;
  if(!url || new URL(url).pathname!=="/brain_ci")
    throw new Error("disposable brain_ci required");
  const first=postgres(url,{max:2,connect_timeout:5});
  const second=postgres(url,{max:2,connect_timeout:5});
  let reserved;
  const pool={
    async reserve(){
      reserved=await first.reserve();
      return reserved;
    }
  };
  const conversationId=crypto.randomUUID();
  let releaseOld;
  try{
    releaseOld=await postgresTurnLock(pool).tryAcquire(conversationId);
    assert.equal(typeof releaseOld,"function");
    const [{pid}]=await reserved.unsafe("SELECT pg_backend_pid() AS pid");
    assert.equal(await postgresTurnLock(second).tryAcquire(conversationId),null,
      "healthy held session must exclude a second worker");

    const killed=await second.unsafe(
      "SELECT pg_terminate_backend($1::int) AS terminated",[pid]);
    assert.equal(killed[0].terminated,true);

    // A new session can now enter, although application code in the old
    // worker may still be executing an async provider/RAG operation.
    const releaseNew=await postgresTurnLock(second).tryAcquire(conversationId);
    assert.equal(typeof releaseNew,"function",
      "session loss invalidates exclusion; this is an operational blocker");
    try{
      await assert.rejects(releaseOld,
        "stale lock owner must not report a clean unlock");
    }finally{
      await releaseNew();
      releaseOld=undefined;
    }
  }finally{
    if(releaseOld)await releaseOld().catch(()=>{});
    await Promise.allSettled([first.end({timeout:1}),second.end({timeout:1})]);
  }
});
