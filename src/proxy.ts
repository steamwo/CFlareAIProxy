// Compatibility export for older imports. Keep a single proxy implementation so
// request logging, five-minute aggregation and error retention cannot diverge.
export { proxyGeneration } from "./proxy-v2";
