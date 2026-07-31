import type { PublicModel } from "../types";
import { normalizeAllowedModelSelection } from "./model-selection";

export function partitionKeyModelSelection(
  values: readonly string[],
  models: readonly PublicModel[],
): { available: string[]; unavailable: string[] } {
  const normalized = normalizeAllowedModelSelection(values, models);
  const availableIds = new Set(models.map((model) => model.id));
  return {
    available: normalized.filter((value) => availableIds.has(value)),
    unavailable: normalized.filter((value) => !availableIds.has(value)),
  };
}

export function mergeKeyModelSelection(
  selected: readonly string[],
  retainedUnavailable: readonly string[],
  models: readonly PublicModel[],
): string[] {
  return normalizeAllowedModelSelection(
    [...retainedUnavailable, ...selected],
    models,
  );
}
