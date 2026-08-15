import type { QoderToolRoute } from "./qoder-protocol";

const routesByRequest = new Map<string, Map<string, QoderToolRoute>>();
const MAX_ENTRIES = 256;

export function rememberQoderToolRoutes(requestId: string, routes: Map<string, QoderToolRoute>): void {
  if (!routes.size) return;
  if (routesByRequest.size >= MAX_ENTRIES) routesByRequest.delete(routesByRequest.keys().next().value as string | undefined);
  routesByRequest.set(requestId, new Map(routes));
}

export function takeQoderToolRoutes(requestId: string): Map<string, QoderToolRoute> {
  const routes = routesByRequest.get(requestId) ?? new Map<string, QoderToolRoute>();
  routesByRequest.delete(requestId);
  return routes;
}
