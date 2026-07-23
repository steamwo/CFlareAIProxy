import type { Env, ProxyRequestContext, UpstreamBuildResult } from "../types";
import { buildCodexRequest } from "./codex";
import { buildGenericRequest } from "./generic";
import { buildOpenCodeRequest } from "./opencode";
import { buildQoderRequest } from "./qoder";

export async function buildUpstreamRequest(context: ProxyRequestContext, env: Env): Promise<UpstreamBuildResult> {
  switch (context.provider.kind) {
    case "codex":
      return buildCodexRequest(context);
    case "qoder":
      return buildQoderRequest(context, env);
    case "opencode":
      return buildOpenCodeRequest(context);
    case "kimi":
    case "custom":
    case "openai-compatible":
    default:
      return buildGenericRequest(context);
  }
}
