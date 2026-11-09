type AxisLabel = Readonly<{ x: number; width: number }>;

type AxisTick = Readonly<{ index: number; anchor: "middle" | "end" }>;

/** All dimensions are rendered CSS pixels, including the minimum label gap. */
export const streamAxisTicks = (
  labels: ReadonlyArray<AxisLabel>,
  plotWidth: number,
  containerWidth: number,
  minGap: number = 12,
): ReadonlyArray<AxisTick> => {
  if (labels.length === 0) return [];
  const labelWidth = Math.max(...labels.map((label) => label.width));
  // February's shorter interval must fit too, not just the average month.
  const minMonthSpacing = labels.slice(1).reduce(
    (spacing, label, index) => Math.min(spacing, label.x - labels[index].x),
    plotWidth,
  );
  const usableWidth = Math.min(plotWidth, minMonthSpacing * (labels.length - 1));
  const maxTicks = Math.max(2, Math.floor(usableWidth / (labelWidth + minGap)));
  const step = Math.max(1, Math.ceil((labels.length - 1) / (maxTicks - 1)));
  const lastIndex = labels.length - 1;
  const last = labels[lastIndex];
  // Preserve upstream's centered labels whenever the end label fits the SVG.
  const anchor = last.x + last.width / 2 > containerWidth ? "end" : "middle";
  const lastStart = last.x - last.width * (anchor === "end" ? 1 : 0.5);
  const clearsLast = (index: number): boolean =>
    lastStart - (labels[index].x + labels[index].width / 2) >= minGap;
  const lastTick: AxisTick = { index: lastIndex, anchor };

  // Count back from the last month so every interval, including the final one, is equal.
  for (let interval = step; interval <= lastIndex; interval += 1) {
    const ticks: Array<AxisTick> = [];
    for (let index = lastIndex - interval; index >= 0; index -= interval) {
      ticks.unshift({ index, anchor: "middle" });
    }
    if (ticks.length === 0 || clearsLast(ticks[ticks.length - 1].index)) return [...ticks, lastTick];
    // With every month labelled, dropping the one colliding label keeps upstream's density.
    if (interval === 1) return [...ticks.slice(0, -1), lastTick];
  }
  return [lastTick];
};
