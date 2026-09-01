function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function serializedOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function normalizeChatImageDetail(value: unknown): { ok: boolean; detail?: "auto" | "low" | "high" } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false };
  const detail = value.trim().toLowerCase();
  if (detail === "auto" || detail === "low" || detail === "high") return { ok: true, detail };
  if (detail === "original") return { ok: true, detail: "high" };
  return { ok: true };
}

function chatImageFields(value: unknown): { url: string; detail?: "auto" | "low" | "high" } | undefined {
  const item = record(value);
  const type = item.type;
  let rawUrl: unknown;
  let rawDetail: unknown;

  if (type === "image_url") {
    const image = record(item.image_url);
    rawUrl = image.url;
    rawDetail = image.detail;
  } else if (type === "input_image") {
    rawUrl = item.image_url;
    rawDetail = item.detail;
  } else {
    return undefined;
  }

  if (typeof rawUrl !== "string" || !rawUrl.trim()) return undefined;
  const normalizedDetail = normalizeChatImageDetail(rawDetail);
  if (!normalizedDetail.ok) return undefined;
  return { url: rawUrl.trim(), ...(normalizedDetail.detail ? { detail: normalizedDetail.detail } : {}) };
}

function fallbackPart(value: unknown): Record<string, unknown> {
  return { type: "text", text: serializedOutput(value) };
}

function convertedStructuredParts(value: unknown): { parts: Array<Record<string, unknown>>; hasImage: boolean; allText: boolean } | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: Array<Record<string, unknown>> = [];
  let hasImage = false;
  let allText = true;

  for (const raw of value) {
    const item = record(raw);
    const type = typeof item.type === "string" ? item.type : "";
    if (type === "text" || type === "input_text" || type === "output_text") {
      if (typeof item.text !== "string") return undefined;
      parts.push({ type: "text", text: item.text });
      continue;
    }
    if (type === "image_url" || type === "input_image") {
      const image = chatImageFields(item);
      if (!image) return undefined;
      hasImage = true;
      allText = false;
      parts.push({
        type: "image_url",
        image_url: { url: image.url, ...(image.detail ? { detail: image.detail } : {}) },
      });
      continue;
    }
    allText = false;
    parts.push(fallbackPart(raw));
  }

  return { parts, hasImage, allText };
}

export function responsesToolOutputToChatContent(output: unknown): string | Array<Record<string, unknown>> {
  let structured = output;
  if (typeof output === "string") {
    try {
      structured = JSON.parse(output) as unknown;
    } catch {
      return output;
    }
  }

  const converted = convertedStructuredParts(structured);
  if (!converted) return serializedOutput(output);
  if (converted.hasImage) return converted.parts;
  if (converted.allText) return converted.parts.map((part) => String(part.text ?? "")).join("");
  return serializedOutput(output);
}
