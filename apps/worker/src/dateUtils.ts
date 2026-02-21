/**
 * Date utility functions for exchange rate fetcher worker.
 */

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(startStr: string, endStr: string): number {
  const start = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr + "T00:00:00Z");
  return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatDdMmYyyy(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}
