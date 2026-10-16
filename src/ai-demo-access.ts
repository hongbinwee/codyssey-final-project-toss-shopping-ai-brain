// Process-local cost guard for the read-only, authenticated live demonstration.
export function createAiDemoGate(totalLimit = 20, perUserLimit = 6) {
  let total = 0;
  let active = 0;
  const users = new Map<string, { count: number; active: boolean }>();
  return {
    take(user: string): { ok: false; code: string } | { ok: true; release(): void } {
      const state = users.get(user) ?? { count: 0, active: false };
      if (total >= totalLimit || state.count >= perUserLimit)
        return { ok: false, code: "AI_DEMO_LIMIT" };
      if (active >= 2 || state.active) return { ok: false, code: "AI_DEMO_BUSY" };
      state.count++; state.active = true; total++; active++;
      users.set(user, state);
      let released = false;
      return { ok: true, release() {
        if (released) return;
        released = true; state.active = false; active--;
      } };
    },
  };
}
