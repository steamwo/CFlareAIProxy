import { restoreCodexMultiAgentResponse } from "./codex-multi-agent-response";
import { prepareCodexCustomToolResponse } from "./codex-custom-response";
import { prepareKimiResponse } from "./kimi-response";
import { stopOpenAiCompatibleSseAfterDone } from "./openai-compatible-response";
import { prepareQoderResponse } from "./qoder-response";
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
  if (context.providerKind === "codex") response = await prepareCodexCustomToolResponse(context);
  else if (context.providerKind === "kimi") response = await prepareKimiResponse(context);
  else if (context.providerKind === "qoder") response = await prepareQoderResponse(context);
  else {
    response = await prepareDownstreamResponse(context.upstream, context.mode, context.requestedStream, context.model, context.requestId);
    if (context.providerKind === "openai-compatible" && context.mode === "passthrough" && context.requestedStream) {
      response = stopOpenAiCompatibleSseAfterDone(response);
    }
    if (context.forceResponseModelMapping) response = await rewriteResponseModels(response, context.model);
  }
  return restoreCodexMultiAgentResponse(response, context.restoreCodexCollaborationNamespace === true);
}
