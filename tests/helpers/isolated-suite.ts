// PMQA-078 fixed source inventory. Counts below are static test() call
// inventory only; collection and execution counts require the approved runner.
export const E2E_BASELINE_SPECS = Object.freeze([
  "checkout-06a.spec.ts",
  "checkout-t2.spec.ts",
  "core-journeys.spec.ts",
  "nav.spec.ts",
  "smoke.spec.ts",
  "t1-complete.spec.ts",
  "t1-slice.spec.ts",
  "t3-cancel.spec.ts",
  "t4-product-cart.spec.ts",
] as const);

export const E2E_ADDITION_SPECS = Object.freeze([
  "checkout-c.spec.ts",
  "wishlist.spec.ts",
] as const);

export const E2E_SPECS = Object.freeze([
  ...E2E_BASELINE_SPECS,
  ...E2E_ADDITION_SPECS,
]);

export const E2E_SOURCE_INVENTORY = Object.freeze({
  baselineRegularStaticCalls: 68,
  baselineRegularFiles: E2E_BASELINE_SPECS.length,
  newCheckoutStaticCalls: 3,
  newWishlistStaticCalls: 2,
  newStaticCalls: 5,
  legacyCapture: Object.freeze({
    file: "zz-pmqa040-capture.spec.ts",
    status: "NOT_READY",
    historicalStaticCalls: 1,
    reason:
      "spec worker owns claim/write handles; minimum parent-broker submission hook is not connected",
  }),
});

// PMQA-078 fixed integration denominator. Destructive demo-seed safety tests
// are explicitly excluded and receive no pass credit under this runner.
export const INTEGRATION_SPECS = Object.freeze([
  "cancel-confirmation.test.ts",
  "cancel-race.test.ts",
  "cancel-recovery.test.ts",
  "checkout.test.ts",
  "health.test.ts",
  "session-api.test.ts",
  "t1-cart.test.ts",
  "t1-catalog.test.ts",
  "t2-orders.test.ts",
  "wishlist.test.ts",
] as const);

export const EXCLUDED_INTEGRATION = Object.freeze({
  file: "demo-seed.test.ts",
  sourceTests: 5,
  status: "NOT_RUN",
  reason: "previous protected-DB deletion incident and current user restriction",
});
