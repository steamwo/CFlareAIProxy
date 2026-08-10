import type { ProxyRequestContext } from "./types";

export type ReasoningSummaryIntent = "unspecified" | "disabled" | "auto" | "concise" | "detailed";

const routeSupportByBody = new WeakMap<Record<string, unknown>, boolean>();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function reasoningSummaryIntent(body: Record<string, unknown>): ReasoningSummaryIntent {
  const reasoning = record(body.reasoning);
  if (!hasOwn(reasoning, "summary")) return "unspecified";
  const value = reasoning.summary;
  if (value === null || value === false) return "disabled";
  if (typeof value !== "string") return "unspecified";
  switch (value.trim().toLowerCase()) {
    case "none":
    case "disabled":
    case "off":
      return "disabled";
    case "auto":
      return "auto";
    case "concise":
      return "concise";
    case "detailed":
      return "detailed";
    default:
      return "unspecified";
  }
}

export function setReasoningSummaryRouteSupport(body: Record<string, unknown>, support: boolean | undefined): void {
  routeSupportByBody.delete(body);
  if (support !== undefined) routeSupportByBody.set(body, support);
}

function removeSummary(body: Record<string, unknown>): void {
  const reasoning = record(body.reasoning);
  if (!hasOwn(reasoning, "summary")) return;
  const next = { ...reasoning };
  delete next.summary;
  if (Object.keys(next).length > 0) body.reasoning = next;
  else delete body.reasoning;
}

/**
 * Applies only summary visibility. Reasoning effort and every other reasoning field remain
 * owned by the normal provider/default/override pipeline. This prevents a translated or
 * configured request from inventing summary visibility the caller never asked for while
 * still allowing provider configuration to tune effort independently.
 */
export function applyReasoningSummaryIntent(
  outgoing: Record<string, unknown>,
  context: Pick<ProxyRequestContext, "body">,
): void {
  const intent = reasoningSummaryIntent(context.body);
  const supported = routeSupportByBody.get(context.body);
  if (supported === false || intent === "unspecified" || intent === "disabled") {
    removeSummary(outgoing);
    return;
  }
  outgoing.reasoning = { ...record(outgoing.reasoning), summary: intent };
}
