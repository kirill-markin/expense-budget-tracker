import type { SqlExecutionDeadline } from "@expense-budget-tracker/agent-shared/sql-policy";
import { recordUserOpenDayBeforeDeadline, type OpenDaySurface } from "./db.js";

type RecordOpenDay = (
  userId: string,
  surface: OpenDaySurface,
  deadline: SqlExecutionDeadline,
) => Promise<void>;

type OpenDayCache = Readonly<{
  day: string;
  keys: ReadonlySet<string>;
}>;

const toUtcDay = (date: Date): string => date.toISOString().slice(0, 10);

const toOpenDayKey = (userId: string, surface: OpenDaySurface): string => `${userId}|${surface}`;

const isRecorded = (cache: OpenDayCache, day: string, key: string): boolean =>
  cache.day === day && cache.keys.has(key);

const markRecorded = (cache: OpenDayCache, day: string, key: string): OpenDayCache => ({
  day,
  keys: new Set(cache.day === day ? [...cache.keys, key] : [key]),
});

/**
 * Skip the database write once this process has recorded the person's surface
 * for the current UTC day. A key is marked only after its write succeeds, so a
 * failed write is attempted again by the next request.
 */
export const createOpenDayRecorder = (
  recordOpenDay: RecordOpenDay,
  now: () => Date,
): RecordOpenDay => {
  let cache: OpenDayCache = { day: "", keys: new Set() };
  return async (userId, surface, deadline): Promise<void> => {
    const day = toUtcDay(now());
    const key = toOpenDayKey(userId, surface);
    if (isRecorded(cache, day, key)) {
      return;
    }
    await recordOpenDay(userId, surface, deadline);
    cache = markRecorded(cache, day, key);
  };
};

export const recordOpenDayOncePerDay: RecordOpenDay = createOpenDayRecorder(
  recordUserOpenDayBeforeDeadline,
  () => new Date(),
);
