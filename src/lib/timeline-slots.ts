export type TimelineRange<T extends { id: string }> = {
  item: T;
  startMs: number;
  endMs: number;
};

export function rangeOverlapsMs(
  startMs: number,
  endMs: number,
  itemStartMs: number,
  itemEndMs: number,
) {
  return startMs < itemEndMs && endMs > itemStartMs;
}

export function findOverlappingTimelineItem<T extends { id: string }>(
  ranges: Array<TimelineRange<T>>,
  startMs: number,
  endMs: number,
  ignoreItemId?: string | null,
) {
  return ranges.find(
    (range) =>
      range.item.id !== ignoreItemId &&
      rangeOverlapsMs(startMs, endMs, range.startMs, range.endMs),
  )?.item;
}
