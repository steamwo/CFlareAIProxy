import { prepareCodexResponse } from "./codex-response";
import { prepareKimiResponse } from "./kimi-response";
import { rewriteResponseModels } from "./response-utils";
import { prepareDownstreamResponse } from "./stream";
import type { GatewayEndpoint, ProviderKind, UpstreamResponseMode } from "./types";

export interface ProviderResponseContext {
  upstream: Response;
  mode: UpstreamResponseMode;
  requestedStream: boolean;
  model: string;
  requestId: string;
  providerKind: ProviderKind;
  endpoint: GatewayEndpoint;
  forceResponseModelMapping?: boolean;
}

export async function prepareProviderResponse(context: ProviderResponseContext): Promise<Response> {
  if (context.providerKind === "codex") return prepareCodexResponse(context);
  if (context.providerKind === "kimi") return prepareKimiResponse(context);
  const response = await prepareDownstreamResponse(context.upstream, context.mode, context.requestedStream, context.model, context.requestId);
  return context.forceResponseModelMapping ? await rewriteResponseModels(response, context.model) : response;
}
