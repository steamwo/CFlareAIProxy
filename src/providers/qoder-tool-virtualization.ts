type JsonRecord = Record<string, unknown>;

export const QODER_AUTO_TOOL_SEARCH_THRESHOLD = 96;
export const QODER_AUTO_TOOL_SEARCH_CORE_LIMIT = 24;
export const QODER_AUTO_TOOL_SEARCH_CORE_FLOOR = 8;
export const QODER_PROXY_TOOL_SEARCH_RESULT_MAX = 12;

export interface QoderResponsesFunctionCandidate {
  ordinal: number;
  tool: JsonRecord;
  namespace: string;
  namespaceDescription: string;
  core: boolean;
}

export interface QoderResponsesProjection {
  body: JsonRecord;
  proxyManaged: boolean;
  functionLeaves: number;
  visibleFunctions: number;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function toolsFrom(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : [];
}

function toolDeferred(tool: JsonRecord): boolean {
  return tool.defer_loading === true;
}

function responsesCoreTool(tool: JsonRecord): boolean {
  if (stringValue(tool.type) !== "function") return false;
  const name = stringValue(tool.name).trim().toLowerCase();
  if (!name) return false;
  return [
    "read", "write", "edit", "patch", "file", "grep", "glob",
    "shell", "bash", "exec", "command", "terminal", "git", "plan",
  ].some((token) => name.includes(token));
}

export function qoderResponsesFunctionCandidates(tools: unknown): QoderResponsesFunctionCandidate[] {
  const output: QoderResponsesFunctionCandidate[] = [];
  let ordinal = 0;
  const visit = (items: JsonRecord[], namespace: string, namespaceDescription: string): void => {
    for (const tool of items) {
      const type = stringValue(tool.type);
      if (type === "function") {
        output.push({
          ordinal,
          tool,
          namespace,
          namespaceDescription,
          core: responsesCoreTool(tool),
        });
        ordinal += 1;
        continue;
      }
      if (type === "namespace") {
        const nextNamespace = stringValue(tool.name).trim() || namespace;
        const nextDescription = stringValue(tool.description).trim() || namespaceDescription;
        visit(toolsFrom(tool.tools), nextNamespace, nextDescription);
      }
    }
  };
  visit(toolsFrom(tools), "", "");
  return output;
}

function responsesToolsHaveSearch(tools: unknown): boolean {
  for (const tool of toolsFrom(tools)) {
    const type = stringValue(tool.type);
    if (type === "tool_search") return true;
    if (type === "namespace" && responsesToolsHaveSearch(tool.tools)) return true;
  }
  return false;
}

function selectCoreFunctions(candidates: QoderResponsesFunctionCandidate[]): Set<number> {
  const selected = new Set<number>();
  for (const candidate of candidates) {
    if (selected.size >= QODER_AUTO_TOOL_SEARCH_CORE_LIMIT) break;
    if (candidate.core) selected.add(candidate.ordinal);
  }
  if (selected.size < QODER_AUTO_TOOL_SEARCH_CORE_FLOOR) {
    for (const candidate of candidates) {
      if (selected.size >= QODER_AUTO_TOOL_SEARCH_CORE_FLOOR) break;
      selected.add(candidate.ordinal);
    }
  }
  return selected;
}

function syntheticToolSearch(): JsonRecord {
  return {
    type: "tool_search",
    execution: "proxy",
    description: "Search the proxy-managed deferred tool registry for capabilities that are not currently visible. Use this before concluding that a tool is unavailable.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Capability, action, integration, or tool to find." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

function projectLargeTool(tool: JsonRecord, selected: Set<number>, ordinal: { value: number }): JsonRecord | undefined {
  const type = stringValue(tool.type);
  if (type === "function") {
    const current = ordinal.value;
    ordinal.value += 1;
    if (!selected.has(current)) return undefined;
    const clone = cloneJson(tool);
    delete clone.defer_loading;
    return clone;
  }
  if (type === "tool_search") {
    const clone = cloneJson(tool);
    delete clone.defer_loading;
    return clone;
  }
  if (type === "namespace") {
    const clone = cloneJson(tool);
    delete clone.defer_loading;
    const children = toolsFrom(tool.tools)
      .map((child) => projectLargeTool(child, selected, ordinal))
      .filter((child): child is JsonRecord => child !== undefined);
    if (!children.length) return undefined;
    clone.tools = children;
    return clone;
  }
  return cloneJson(tool);
}

function filterExplicitDeferred(tool: JsonRecord): JsonRecord | undefined {
  const type = stringValue(tool.type);
  if (type === "function" && toolDeferred(tool)) return undefined;
  if (type === "tool_search") {
    const clone = cloneJson(tool);
    delete clone.defer_loading;
    return clone;
  }
  if (type === "namespace") {
    if (toolDeferred(tool)) return undefined;
    const clone = cloneJson(tool);
    const children = toolsFrom(tool.tools)
      .map(filterExplicitDeferred)
      .filter((child): child is JsonRecord => child !== undefined);
    if (!children.length) return undefined;
    clone.tools = children;
    return clone;
  }
  return cloneJson(tool);
}

export function qoderResponsesNeedsProxyToolSearch(tools: unknown): boolean {
  return qoderResponsesFunctionCandidates(tools).length >= QODER_AUTO_TOOL_SEARCH_THRESHOLD
    && !responsesToolsHaveSearch(tools);
}

export function projectQoderResponsesBody(body: JsonRecord): QoderResponsesProjection {
  const initialTools = toolsFrom(body.tools);
  const candidates = qoderResponsesFunctionCandidates(initialTools);
  const hasSearch = responsesToolsHaveSearch(initialTools);
  const proxyManaged = candidates.length >= QODER_AUTO_TOOL_SEARCH_THRESHOLD && !hasSearch;

  if (!initialTools.length) {
    return { body, proxyManaged: false, functionLeaves: 0, visibleFunctions: 0 };
  }

  let projected: JsonRecord[];
  if (candidates.length >= QODER_AUTO_TOOL_SEARCH_THRESHOLD) {
    const selected = selectCoreFunctions(candidates);
    const ordinal = { value: 0 };
    projected = initialTools
      .map((tool) => projectLargeTool(tool, selected, ordinal))
      .filter((tool): tool is JsonRecord => tool !== undefined);
    if (!hasSearch) projected.unshift(syntheticToolSearch());
  } else if (hasSearch) {
    projected = initialTools
      .map(filterExplicitDeferred)
      .filter((tool): tool is JsonRecord => tool !== undefined);
  } else {
    projected = cloneJson(initialTools);
  }

  return {
    body: { ...body, tools: projected },
    proxyManaged,
    functionLeaves: candidates.length,
    visibleFunctions: qoderResponsesFunctionCandidates(projected).length,
  };
}

function searchTerms(query: string): string[] {
  const stop = new Set([
    "all", "available", "tool", "tools", "find", "search", "please", "the",
    "a", "an", "to", "for", "of", "use", "with",
  ]);
  const raw = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const seen = new Set<string>();
  const output: string[] = [];
  for (const term of raw) {
    if (term.length < 2 || stop.has(term) || seen.has(term)) continue;
    seen.add(term);
    output.push(term);
  }
  return output;
}

function candidateScore(candidate: QoderResponsesFunctionCandidate, rawQuery: string, terms: string[]): number {
  const name = stringValue(candidate.tool.name).toLowerCase();
  const namespace = candidate.namespace.toLowerCase();
  const description = stringValue(candidate.tool.description).toLowerCase();
  const query = rawQuery.trim().toLowerCase();
  let score = 0;
  if (query) {
    if (name.includes(query)) score += 120;
    if (namespace && namespace.includes(query)) score += 70;
    if (description.includes(query)) score += 25;
  }
  let allMatched = terms.length > 0;
  for (const term of terms) {
    let matched = false;
    if (name.includes(term)) { score += 40; matched = true; }
    if (namespace && namespace.includes(term)) { score += 25; matched = true; }
    if (description.includes(term)) { score += 8; matched = true; }
    if (!matched) allMatched = false;
  }
  if (allMatched) score += 40;
  return score;
}

export function searchDeferredQoderResponsesTools(
  tools: unknown,
  query: string,
  limit = QODER_PROXY_TOOL_SEARCH_RESULT_MAX,
): QoderResponsesFunctionCandidate[] {
  const candidates = qoderResponsesFunctionCandidates(tools);
  const selected = selectCoreFunctions(candidates);
  const effectiveLimit = limit > 0 ? limit : QODER_PROXY_TOOL_SEARCH_RESULT_MAX;
  const deferred = candidates.filter((candidate) => !selected.has(candidate.ordinal));
  const terms = searchTerms(query);
  const scored = deferred
    .map((candidate) => ({ candidate, score: candidateScore(candidate, query, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.ordinal - right.candidate.ordinal);

  if (!scored.length) return deferred.slice(0, effectiveLimit);
  return scored.slice(0, effectiveLimit).map((entry) => entry.candidate);
}

export function qoderSearchResultTools(matches: QoderResponsesFunctionCandidate[]): JsonRecord[] {
  const output: JsonRecord[] = [];
  const namespaceIndexes = new Map<string, number>();
  for (const candidate of matches) {
    const clone = cloneJson(candidate.tool);
    delete clone.defer_loading;
    if (!candidate.namespace) {
      output.push(clone);
      continue;
    }
    const key = `${candidate.namespace}\u0000${candidate.namespaceDescription}`;
    let index = namespaceIndexes.get(key);
    if (index === undefined) {
      const namespace: JsonRecord = { type: "namespace", name: candidate.namespace, tools: [] };
      if (candidate.namespaceDescription) namespace.description = candidate.namespaceDescription;
      output.push(namespace);
      index = output.length - 1;
      namespaceIndexes.set(key, index);
    }
    const namespace = output[index]!;
    const children = toolsFrom(namespace.tools);
    children.push(clone);
    namespace.tools = children;
  }
  return output;
}

export function qoderCandidateDisplayName(candidate: QoderResponsesFunctionCandidate): string {
  const name = stringValue(candidate.tool.name).trim();
  return candidate.namespace ? `${candidate.namespace}__${name}` : name;
}
