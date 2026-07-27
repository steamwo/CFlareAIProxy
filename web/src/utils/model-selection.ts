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

function publicModelSource(model: PublicModel): string {
  const provider = model.x_cflare_provider?.trim();
  if (provider) return provider;

  const separator = model.id.indexOf("/");
  if (separator > 0) return model.id.slice(0, separator);

  const owner = model.owned_by?.trim();
  return owner && owner !== "cflare-route" ? owner : "路由";
}

export function publicModelOptions(models: readonly PublicModel[]): SelectOption[] {
  return models.map((model) => ({
    label: `${model.display_name?.trim() || model.id} · ${publicModelSource(model)}`,
    value: model.id,
  }));
}
