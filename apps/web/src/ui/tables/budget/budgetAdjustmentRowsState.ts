import type {
  BudgetAdjustment,
  BudgetAdjustmentDirection,
} from "@/server/budget/budgetAdjustments";
import type { BudgetRow } from "@/server/budget/getBudgetGrid";

const AMOUNT_PATTERN = /^[+-]?\d+$/;
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export type BudgetAdjustmentSnapshot = Readonly<{
  amount: number;
  note: string | null;
  month: string;
  category: string;
}>;

export type BudgetAdjustmentDraft = Readonly<{
  amountInput: string;
  noteInput: string;
  month: string;
  category: string;
}>;

export type BudgetAdjustmentEditorRow = Readonly<{
  adjustmentId: string;
  direction: BudgetAdjustmentDirection;
  draft: BudgetAdjustmentDraft;
  confirmed: BudgetAdjustmentSnapshot;
  createdAt: string;
  updatedAt: string;
}>;

export type BudgetAdjustmentDraftError = Readonly<{
  code: "invalidAmount" | "unsafeAmount" | "invalidMonth" | "pastMonth" | "invalidCategory" | "invalidNote";
  message: string;
}>;

export type ParsedBudgetAdjustmentAmount =
  | Readonly<{ ok: true; amount: number }>
  | Readonly<{ ok: false; error: BudgetAdjustmentDraftError }>;

export type ParsedBudgetAdjustmentDraft =
  | Readonly<{ ok: true; snapshot: BudgetAdjustmentSnapshot }>
  | Readonly<{ ok: false; error: BudgetAdjustmentDraftError }>;

export type BudgetAdjustmentCellMove = Readonly<{
  direction: BudgetAdjustmentDirection;
  previous: BudgetAdjustmentSnapshot;
  current: BudgetAdjustmentSnapshot;
}>;

type BudgetAdjustmentLocation = Readonly<{
  month: string;
  category: string;
}>;

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const validateMonth = (month: string, context: string): void => {
  if (!MONTH_PATTERN.test(month)) {
    throw new RangeError(`${context} must use YYYY-MM with a valid month; received "${month}"`);
  }
};

const validateRange = (monthFrom: string, monthTo: string, context: string): void => {
  validateMonth(monthFrom, `${context} monthFrom`);
  validateMonth(monthTo, `${context} monthTo`);
  if (monthFrom > monthTo) {
    throw new RangeError(`${context} monthFrom "${monthFrom}" must not be after monthTo "${monthTo}"`);
  }
};

const validateRevision = (revision: number, context: string): void => {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RangeError(`${context} must be a non-negative safe integer; received ${String(revision)}`);
  }
};

export const isValidBudgetAdjustmentCategory = (category: string): boolean => {
  const length = Array.from(category).length;
  return length >= 1 && length <= 200;
};

export const getBudgetAdjustmentCategoryOptions = (
  categories: ReadonlyArray<string>,
  effectiveAllowlist: ReadonlySet<string> | null,
): ReadonlyArray<string> => [...new Set(categories.filter((category): boolean =>
  isValidBudgetAdjustmentCategory(category)
  && (effectiveAllowlist === null || effectiveAllowlist.has(category))))];

const isValidDraftLocation = (draft: BudgetAdjustmentDraft, planFrom: string): boolean =>
  MONTH_PATTERN.test(draft.month)
  && draft.month >= planFrom
  && isValidBudgetAdjustmentCategory(draft.category);

const getEffectiveLocation = (
  row: BudgetAdjustmentEditorRow,
  planFrom: string,
): BudgetAdjustmentLocation => isValidDraftLocation(row.draft, planFrom)
  ? { month: row.draft.month, category: row.draft.category }
  : { month: row.confirmed.month, category: row.confirmed.category };

export const budgetAdjustmentNoteToInput = (note: string | null): string => note ?? "";

export const budgetAdjustmentNoteFromInput = (noteInput: string): string | null =>
  noteInput === "" ? null : noteInput;

export const parseBudgetAdjustmentAmount = (
  amountInput: string,
): ParsedBudgetAdjustmentAmount => {
  const value = amountInput.trim();
  if (value.length === 0) return { ok: true, amount: 0 };
  if (!AMOUNT_PATTERN.test(value)) {
    return {
      ok: false,
      error: {
        code: "invalidAmount",
        message: `Budget adjustment amount "${amountInput}" must be a signed integer or blank`,
      },
    };
  }
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) {
    return {
      ok: false,
      error: {
        code: "unsafeAmount",
        message: `Budget adjustment amount "${amountInput}" is outside the safe integer range`,
      },
    };
  }
  return { ok: true, amount };
};

export const parseBudgetAdjustmentDraft = (
  draft: BudgetAdjustmentDraft,
  currentMonth: string,
): ParsedBudgetAdjustmentDraft => {
  validateMonth(currentMonth, "Current month");
  const amount = parseBudgetAdjustmentAmount(draft.amountInput);
  if (!amount.ok) return amount;
  if (!MONTH_PATTERN.test(draft.month)) {
    return {
      ok: false,
      error: {
        code: "invalidMonth",
        message: `Budget adjustment month "${draft.month}" must use YYYY-MM with a valid month`,
      },
    };
  }
  if (draft.month < currentMonth) {
    return {
      ok: false,
      error: {
        code: "pastMonth",
        message: `Budget adjustment month "${draft.month}" must be ${currentMonth} or later`,
      },
    };
  }
  if (!isValidBudgetAdjustmentCategory(draft.category)) {
    return {
      ok: false,
      error: {
        code: "invalidCategory",
        message: "Budget adjustment category must contain between 1 and 200 characters",
      },
    };
  }
  if (Array.from(draft.noteInput).length > 2000) {
    return {
      ok: false,
      error: {
        code: "invalidNote",
        message: "Budget adjustment note must contain at most 2000 characters",
      },
    };
  }
  return {
    ok: true,
    snapshot: {
      amount: amount.amount,
      note: budgetAdjustmentNoteFromInput(draft.noteInput),
      month: draft.month,
      category: draft.category,
    },
  };
};

export const createBudgetAdjustmentEditorRow = (
  adjustment: BudgetAdjustment,
): BudgetAdjustmentEditorRow => {
  validateMonth(adjustment.month, `Budget adjustment "${adjustment.adjustmentId}" month`);
  if (!Number.isSafeInteger(adjustment.amount)) {
    throw new RangeError(
      `Budget adjustment "${adjustment.adjustmentId}" amount must be a safe integer; received ${String(adjustment.amount)}`,
    );
  }
  const note = budgetAdjustmentNoteFromInput(budgetAdjustmentNoteToInput(adjustment.note));
  return {
    adjustmentId: adjustment.adjustmentId,
    direction: adjustment.direction,
    draft: {
      amountInput: String(adjustment.amount),
      noteInput: budgetAdjustmentNoteToInput(adjustment.note),
      month: adjustment.month,
      category: adjustment.category,
    },
    confirmed: {
      amount: adjustment.amount,
      note,
      month: adjustment.month,
      category: adjustment.category,
    },
    createdAt: adjustment.createdAt,
    updatedAt: adjustment.updatedAt,
  };
};

export const sortBudgetAdjustmentRows = (
  rows: ReadonlyArray<BudgetAdjustmentEditorRow>,
): ReadonlyArray<BudgetAdjustmentEditorRow> => [...rows].sort((left, right): number =>
  compareText(left.draft.month, right.draft.month)
  || compareText(left.direction, right.direction)
  || compareText(left.draft.category, right.draft.category)
  || compareText(left.createdAt, right.createdAt)
  || compareText(left.adjustmentId, right.adjustmentId));

export const getBudgetAdjustmentCellKey = (
  month: string,
  direction: BudgetAdjustmentDirection,
  category: string,
): string => `${month}\u0000${direction}\u0000${category}`;

export const getBudgetAdjustmentRowCellKey = (
  row: BudgetAdjustmentEditorRow,
  planFrom: string,
): string => {
  validateMonth(planFrom, "Budget adjustment plan boundary");
  const location = getEffectiveLocation(row, planFrom);
  return getBudgetAdjustmentCellKey(location.month, row.direction, location.category);
};

export const getBudgetAdjustmentCellRows = (
  rows: ReadonlyArray<BudgetAdjustmentEditorRow>,
  month: string,
  direction: BudgetAdjustmentDirection,
  category: string,
  planFrom: string,
): ReadonlyArray<BudgetAdjustmentEditorRow> => {
  validateMonth(planFrom, "Budget adjustment plan boundary");
  return sortBudgetAdjustmentRows(rows.filter((row): boolean => {
    const location = getEffectiveLocation(row, planFrom);
    return location.month === month
      && row.direction === direction
      && location.category === category;
  }));
};

export const replaceBudgetAdjustmentDraft = (
  rows: ReadonlyArray<BudgetAdjustmentEditorRow>,
  adjustmentId: string,
  draft: BudgetAdjustmentDraft,
): ReadonlyArray<BudgetAdjustmentEditorRow> => {
  if (!rows.some((row) => row.adjustmentId === adjustmentId)) {
    throw new Error(`Cannot replace draft for missing budget adjustment "${adjustmentId}"`);
  }
  return sortBudgetAdjustmentRows(rows.map((row): BudgetAdjustmentEditorRow =>
    row.adjustmentId === adjustmentId ? { ...row, draft: { ...draft } } : row));
};

const getOptimisticAmount = (row: BudgetAdjustmentEditorRow): number => {
  const amount = parseBudgetAdjustmentAmount(row.draft.amountInput);
  return amount.ok ? amount.amount : row.confirmed.amount;
};

export const getBudgetAdjustmentCellTotal = (
  rows: ReadonlyArray<BudgetAdjustmentEditorRow>,
  month: string,
  direction: BudgetAdjustmentDirection,
  category: string,
  planFrom: string,
): number => {
  validateMonth(planFrom, "Budget adjustment plan boundary");
  if (month < planFrom) return 0;
  const total = getBudgetAdjustmentCellRows(rows, month, direction, category, planFrom)
    .reduce((sum, row): bigint => sum + BigInt(getOptimisticAmount(row)), BigInt(0));
  return toSafeNumber(total, `Budget adjustment total for ${month}/${direction}/${category}`);
};

type AdjustmentCellTotal = Readonly<{
  month: string;
  direction: BudgetAdjustmentDirection;
  category: string;
  total: bigint;
}>;

const toSafeNumber = (value: bigint, context: string): number => {
  const minimum = BigInt(Number.MIN_SAFE_INTEGER);
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${context} is outside the JavaScript safe integer range: ${value.toString()}`);
  }
  return Number(value);
};

const aggregateAdjustmentRows = (
  rows: ReadonlyArray<BudgetAdjustmentEditorRow>,
  plannedFrom: string,
  loadedTo: string,
  planFrom: string,
): ReadonlyMap<string, AdjustmentCellTotal> => {
  const totals = new Map<string, AdjustmentCellTotal>();
  for (const row of rows) {
    const location = getEffectiveLocation(row, planFrom);
    if (location.month < plannedFrom || location.month > loadedTo) continue;
    const key = getBudgetAdjustmentCellKey(location.month, row.direction, location.category);
    const previous = totals.get(key);
    totals.set(key, {
      month: location.month,
      direction: row.direction,
      category: location.category,
      total: (previous?.total ?? BigInt(0)) + BigInt(getOptimisticAmount(row)),
    });
  }
  return totals;
};

const addPlannedValue = (
  plannedBase: number,
  adjustmentTotal: number,
  context: string,
): number => {
  if (!Number.isFinite(plannedBase) || Math.abs(plannedBase) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${context} base is outside the JavaScript safe numeric range: ${String(plannedBase)}`);
  }
  if (Number.isInteger(plannedBase)) {
    return toSafeNumber(
      BigInt(plannedBase) + BigInt(adjustmentTotal),
      `${context} planned value`,
    );
  }
  const planned = plannedBase + adjustmentTotal;
  if (!Number.isFinite(planned) || Math.abs(planned) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${context} planned value is outside the JavaScript safe numeric range: ${String(planned)}`);
  }
  return planned;
};

const sortBudgetRows = (rows: ReadonlyArray<BudgetRow>): ReadonlyArray<BudgetRow> =>
  [...rows].sort((left, right): number =>
    compareText(left.month, right.month)
    || compareText(left.direction, right.direction)
    || compareText(left.category, right.category));

export const applyBudgetAdjustmentRows = (
  budgetRows: ReadonlyArray<BudgetRow>,
  adjustmentRows: ReadonlyArray<BudgetAdjustmentEditorRow>,
  loadedFrom: string,
  loadedTo: string,
  planFrom: string,
  invalidatedCellKeys: ReadonlySet<string>,
): ReadonlyArray<BudgetRow> => {
  validateRange(loadedFrom, loadedTo, "Budget adjustment display range");
  validateMonth(planFrom, "Budget adjustment plan boundary");
  const plannedFrom = loadedFrom > planFrom ? loadedFrom : planFrom;
  const totals = aggregateAdjustmentRows(adjustmentRows, plannedFrom, loadedTo, planFrom);
  const existingKeys = new Set<string>();
  const result: Array<BudgetRow> = [];

  for (const row of budgetRows) {
    if (
      row.month < loadedFrom
      || row.month > loadedTo
      || row.month < plannedFrom
      || (row.direction !== "income" && row.direction !== "spend")
    ) {
      result.push(row);
      continue;
    }
    const key = getBudgetAdjustmentCellKey(row.month, row.direction, row.category);
    const cellTotal = totals.get(key);
    const hasNoIndependentValue = row.plannedBase === 0
      && row.actual === 0
      && !row.hasUnconvertible;
    const isStaleAdjustmentOnly = hasNoIndependentValue
      && cellTotal === undefined
      && (row.plannedModifier !== 0 || invalidatedCellKeys.has(key));
    if (isStaleAdjustmentOnly) continue;

    existingKeys.add(key);
    const plannedModifier = cellTotal === undefined
      ? 0
      : toSafeNumber(cellTotal.total, `Budget adjustment total for ${row.month}/${row.direction}/${row.category}`);
    result.push({
      ...row,
      plannedModifier,
      planned: addPlannedValue(
        row.plannedBase,
        plannedModifier,
        `Budget cell ${row.month}/${row.direction}/${row.category}`,
      ),
    });
  }

  for (const [key, cell] of totals) {
    if (existingKeys.has(key)) continue;
    const plannedModifier = toSafeNumber(
      cell.total,
      `Budget adjustment total for ${cell.month}/${cell.direction}/${cell.category}`,
    );
    result.push({
      month: cell.month,
      direction: cell.direction,
      category: cell.category,
      plannedBase: 0,
      plannedModifier,
      planned: plannedModifier,
      actual: 0,
      hasUnconvertible: false,
    });
  }
  return sortBudgetRows(result);
};

export const recordBudgetAdjustmentCellMove = (
  current: ReadonlyMap<string, number>,
  move: BudgetAdjustmentCellMove,
  mutationRevision: number,
  planFrom: string,
): ReadonlyMap<string, number> => {
  validateRevision(mutationRevision, "Budget adjustment move revision");
  validateMonth(planFrom, "Budget adjustment plan boundary");
  const next = new Map(current);
  const currentLocation = MONTH_PATTERN.test(move.current.month)
    && move.current.month >= planFrom
    && isValidBudgetAdjustmentCategory(move.current.category)
    ? move.current
    : move.previous;
  if (
    move.previous.month !== currentLocation.month
    || move.previous.category !== currentLocation.category
  ) {
    next.set(
      getBudgetAdjustmentCellKey(
        move.previous.month,
        move.direction,
        move.previous.category,
      ),
      mutationRevision,
    );
  }
  return next;
};

export const recordBudgetAdjustmentCellInvalidation = (
  current: ReadonlyMap<string, number>,
  direction: BudgetAdjustmentDirection,
  snapshot: BudgetAdjustmentSnapshot,
  mutationRevision: number,
): ReadonlyMap<string, number> => {
  validateRevision(mutationRevision, "Budget adjustment cell invalidation revision");
  validateMonth(snapshot.month, "Budget adjustment cell invalidation month");
  if (!isValidBudgetAdjustmentCategory(snapshot.category)) {
    throw new RangeError(
      "Budget adjustment cell invalidation category must contain between 1 and 200 characters",
    );
  }
  const next = new Map(current);
  next.set(
    getBudgetAdjustmentCellKey(snapshot.month, direction, snapshot.category),
    mutationRevision,
  );
  return next;
};

export const clearBudgetAdjustmentCellInvalidations = (
  current: ReadonlyMap<string, number>,
  monthFrom: string,
  monthTo: string,
  rangeRevision: number,
): ReadonlyMap<string, number> => {
  validateRange(monthFrom, monthTo, "Budget adjustment invalidation range");
  validateRevision(rangeRevision, "Budget adjustment range revision");
  const next = new Map(current);
  for (const [key, mutationRevision] of current) {
    const month = key.slice(0, 7);
    if (month >= monthFrom && month <= monthTo && mutationRevision <= rangeRevision) {
      next.delete(key);
    }
  }
  return next;
};
