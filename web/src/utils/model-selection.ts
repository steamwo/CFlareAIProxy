import type { SelectOption } from "naive-ui";
import type { PublicModel } from "../types";

export function normalizeAllowedModelSelection(values: readonly string[], models: readonly PublicModel[]): string[] {
  const aliases = new Map<string, string>();
  for (const model of models) {
    if (model.x_cflare_provider !== "qoder" || !model.x_cflare_upstream_model) continue;
    aliases.set(`qoder/${model.x_cflare_upstream_model}`, model.id);
  }

  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const normalized = aliases.get(value) ?? value;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

export function publicModelOptions(models: readonly PublicModel[]): SelectOption[] {
  return models.map((model) => {
    const displayName = model.display_name?.trim();
    return {
      label: displayName && displayName !== model.id ? `${displayName} · ${model.id}` : model.id,
      value: model.id,
    };
  });
}
