import type { BudgetRow } from "@/server/budget/getBudgetGrid";

export type BudgetBaseCell = Readonly<{
  month: string;
  direction: string;
  category: string;
}>;

export type BudgetBaseAcknowledgementProtection = Readonly<{
  cell: BudgetBaseCell;
  value: number;
  throughRequestGeneration: number;
}>;

export type BudgetBaseProtectionByCell = ReadonlyMap<
  string,
  BudgetBaseAcknowledgementProtection
>;

export type BudgetBaseLocalAcknowledgement = Readonly<{
  value: number;
  version: number;
}>;

export type BudgetBaseLocalAcknowledgementByCell = ReadonlyMap<
  string,
  BudgetBaseLocalAcknowledgement
>;

export type BudgetBaseMutationGenerationByCell = ReadonlyMap<string, number>;

export type IssuedBudgetBaseMutation = Readonly<{
  generation: number;
  generationByCell: BudgetBaseMutationGenerationByCell;
}>;

export type ConsumedBudgetBaseLocalAcknowledgement = Readonly<{
  value: number;
  version: number;
}>;

export type BudgetBaseRangeRequest = Readonly<{
  generation: number;
  monthFrom: string;
  monthTo: string;
}>;

export type ReconciledBudgetBaseRange = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
  protections: BudgetBaseProtectionByCell;
}>;

export const getBudgetBaseCellKey = (cell: BudgetBaseCell): string => (
  `${cell.month}\u0000${cell.direction}\u0000${cell.category}`
);

export const issueBudgetBaseMutation = (
  currentGeneration: number,
  generationByCell: BudgetBaseMutationGenerationByCell,
  cells: ReadonlyArray<BudgetBaseCell>,
): IssuedBudgetBaseMutation => {
  if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 0) {
    throw new RangeError(
      `Budget Base mutation generation must be a non-negative safe integer; received ${String(currentGeneration)}`,
    );
  }
  if (currentGeneration === Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      "Cannot issue another Budget Base mutation: generation limit reached",
    );
  }
  if (cells.length === 0) {
    throw new RangeError("Budget Base mutation must affect at least one cell");
  }

  const generation = currentGeneration + 1;
  const updated = new Map(generationByCell);
  for (const cell of cells) {
    updated.set(getBudgetBaseCellKey(cell), generation);
  }
  return { generation, generationByCell: updated };
};

export const getCurrentBudgetBaseMutationCells = (
  generationByCell: BudgetBaseMutationGenerationByCell,
  cells: ReadonlyArray<BudgetBaseCell>,
  generation: number,
): ReadonlyArray<BudgetBaseCell> => {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new RangeError(
      `Budget Base mutation generation must be a positive safe integer; received ${String(generation)}`,
    );
  }
  return cells.filter((cell): boolean => (
    generationByCell.get(getBudgetBaseCellKey(cell)) === generation
  ));
};

export const consumeBudgetBaseLocalAcknowledgement = (
  plannedBase: number,
  acknowledgement: BudgetBaseLocalAcknowledgement | null,
  consumedVersion: number,
): ConsumedBudgetBaseLocalAcknowledgement => {
  if (
    acknowledgement === null
    || acknowledgement.version <= consumedVersion
  ) {
    return { value: plannedBase, version: consumedVersion };
  }
  return {
    value: acknowledgement.value,
    version: acknowledgement.version,
  };
};

export const publishBudgetBaseLocalAcknowledgements = (
  acknowledgements: BudgetBaseLocalAcknowledgementByCell,
  cells: ReadonlyArray<BudgetBaseCell>,
  value: number,
  version: number,
): BudgetBaseLocalAcknowledgementByCell => {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(
      `Budget Base local acknowledgement value must be a finite integer; received ${String(value)}`,
    );
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError(
      `Budget Base local acknowledgement version must be a positive safe integer; received ${String(version)}`,
    );
  }

  const updated = new Map(acknowledgements);
  for (const cell of cells) {
    updated.set(getBudgetBaseCellKey(cell), { value, version });
  }
  return updated;
};

export const retainProtectedBudgetBaseLocalAcknowledgements = (
  acknowledgements: BudgetBaseLocalAcknowledgementByCell,
  protections: BudgetBaseProtectionByCell,
): BudgetBaseLocalAcknowledgementByCell => {
  const retained = new Map<string, BudgetBaseLocalAcknowledgement>();
  for (const [cellKey, acknowledgement] of acknowledgements) {
    if (protections.has(cellKey)) retained.set(cellKey, acknowledgement);
  }
  return retained;
};

const buildNewBudgetRow = (
  cell: BudgetBaseCell,
  value: number,
): BudgetRow => ({
  month: cell.month,
  direction: cell.direction,
  category: cell.category,
  plannedBase: value,
  plannedModifier: 0,
  planned: value,
  actual: 0,
  hasUnconvertible: false,
});

export const applyBudgetBaseToRows = (
  rows: ReadonlyArray<BudgetRow>,
  cell: BudgetBaseCell,
  value: number,
): ReadonlyArray<BudgetRow> => {
  const rowIndex = rows.findIndex((row): boolean => (
    row.month === cell.month
    && row.direction === cell.direction
    && row.category === cell.category
  ));
  if (rowIndex < 0) return [...rows, buildNewBudgetRow(cell, value)];

  const row = rows[rowIndex];
  const updatedRow: BudgetRow = {
    ...row,
    plannedBase: value,
    planned: value + row.plannedModifier,
  };
  return [...rows.slice(0, rowIndex), updatedRow, ...rows.slice(rowIndex + 1)];
};

export const protectBudgetBaseAcknowledgement = (
  protections: BudgetBaseProtectionByCell,
  protection: BudgetBaseAcknowledgementProtection,
): BudgetBaseProtectionByCell => {
  if (
    !Number.isSafeInteger(protection.throughRequestGeneration)
    || protection.throughRequestGeneration < 0
  ) {
    throw new RangeError(
      `Budget Base protection generation must be a non-negative safe integer; received ${String(protection.throughRequestGeneration)}`,
    );
  }
  if (
    !Number.isFinite(protection.value)
    || !Number.isInteger(protection.value)
  ) {
    throw new RangeError(
      `Budget Base protection value must be a finite integer; received ${String(protection.value)}`,
    );
  }
  const updated = new Map(protections);
  updated.set(getBudgetBaseCellKey(protection.cell), protection);
  return updated;
};

export const reconcileBudgetBaseRange = (
  rows: ReadonlyArray<BudgetRow>,
  protections: BudgetBaseProtectionByCell,
  request: BudgetBaseRangeRequest,
): ReconciledBudgetBaseRange => {
  if (!Number.isSafeInteger(request.generation) || request.generation < 1) {
    throw new RangeError(
      `Budget Base range request generation must be a positive safe integer; received ${String(request.generation)}`,
    );
  }
  if (request.monthFrom > request.monthTo) {
    throw new RangeError(
      `Budget Base range monthFrom "${request.monthFrom}" must not be after monthTo "${request.monthTo}"`,
    );
  }

  let reconciledRows = rows;
  const reconciledProtections = new Map(protections);
  for (const [cellKey, protection] of protections) {
    const { month } = protection.cell;
    if (month < request.monthFrom || month > request.monthTo) continue;

    if (request.generation > protection.throughRequestGeneration) {
      reconciledProtections.delete(cellKey);
      continue;
    }
    reconciledRows = applyBudgetBaseToRows(
      reconciledRows,
      protection.cell,
      protection.value,
    );
  }

  return {
    rows: reconciledRows,
    protections: reconciledProtections,
  };
};
