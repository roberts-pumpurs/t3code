/**
 * omp internals the server's replay tests and fixture recorder drive directly.
 *
 * @module provider-omp/testing
 */
export { makeOmpAdapterV2 } from "./server/adapter.ts";
export { makeOmpAcpRuntime, OMP_DRIVER_KIND, ompApprovalMode } from "./server/acpSupport.ts";
