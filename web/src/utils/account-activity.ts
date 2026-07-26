export interface ActivityBucket {
  bucket: number;
  requests: number;
  successes: number;
  failures: number;
  tokens: number;
}
export interface ActivityTotals {
  requests: number;
  successes: number;
  failures: number;
}
export interface ActivityRecord {
  buckets: ActivityBucket[];
  totals: ActivityTotals;
}

export type ActivityCellStatus = "idle" | "success" | "failure" | "mixed";

export interface ActivityCell extends ActivityBucket {
  /** Shade intensity 0-4, log-scaled against the busiest bucket. */
  level: number;
  status: ActivityCellStatus;
}

export interface ActivitySummary extends ActivityTotals {
  successRate: number;
}

export const ACTIVITY_BUCKET_SECONDS = 5 * 60;
export const ACTIVITY_CELL_COUNT = 24;

export const emptyActivityRecord = (): ActivityRecord => ({
  buckets: [],
  totals: { requests: 0, successes: 0, failures: 0 },
});

/**
 * Projects sparse activity buckets onto a fixed 24-cell strip ending at `nowMs`, so the
 * sparkline always spans the same two-hour window regardless of how many buckets exist.
 */
export function activityCells(record: ActivityRecord, nowMs: number): ActivityCell[] {
  const rows = record.buckets;
  const byBucket = new Map(rows.map((row) => [row.bucket, row] as const));
  const current = Math.floor(nowMs / 1000 / ACTIVITY_BUCKET_SECONDS) * ACTIVITY_BUCKET_SECONDS;
  const max = Math.max(0, ...rows.map((row) => row.requests));
  return Array.from({ length: ACTIVITY_CELL_COUNT }, (_, index) => {
    const bucket = current - (ACTIVITY_CELL_COUNT - 1 - index) * ACTIVITY_BUCKET_SECONDS;
    const row = byBucket.get(bucket) ?? { bucket, requests: 0, successes: 0, failures: 0, tokens: 0 };
    const level = row.requests === 0 || max === 0 ? 0 : Math.max(1, Math.min(4, Math.ceil(Math.log1p(row.requests) / Math.log1p(max) * 4)));
    const status: ActivityCellStatus = row.requests === 0
      ? "idle"
      : row.failures === 0 ? "success" : row.successes === 0 ? "failure" : "mixed";
    return { ...row, level, status };
  });
}

export function activitySummary(record: ActivityRecord): ActivitySummary {
  const value = record.totals;
  return { ...value, successRate: value.requests ? value.successes / value.requests * 100 : 0 };
}

export function successRateClass(summary: ActivitySummary): string {
  if (!summary.requests) return "status-rate--empty";
  if (summary.successRate >= 95) return "status-rate--high";
  return summary.successRate >= 80 ? "status-rate--medium" : "status-rate--low";
}

/** Screen-reader sentence for one activity cell, which is otherwise a bare colour swatch. */
export function activityCellLabel(cell: ActivityCell, timeLabel: string): string {
  if (cell.requests === 0) return `${timeLabel}：无请求`;
  const outcome = cell.status === "success"
    ? "全部成功"
    : cell.status === "failure" ? "全部失败" : `成功 ${cell.successes} 次，失败 ${cell.failures} 次`;
  return `${timeLabel}：${cell.requests} 次请求，${outcome}`;
}
