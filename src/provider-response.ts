import { restoreCodexMultiAgentV2Response } from "./codex-multi-agent-v2";
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
  restoreCodexCollaborationNamespace?: boolean;
}

export async function prepareProviderResponse(context: ProviderResponseContext): Promise<Response> {
  let response: Response;
  if (context.providerKind === "codex") response = await prepareCodexResponse(context);
  else if (context.providerKind === "kimi") response = await prepareKimiResponse(context);
  else {
    response = await prepareDownstreamResponse(context.upstream, context.mode, context.requestedStream, context.model, context.requestId);
    if (context.forceResponseModelMapping) response = await rewriteResponseModels(response, context.model);
  }
  return restoreCodexMultiAgentV2Response(response, context.restoreCodexCollaborationNamespace === true);
}
