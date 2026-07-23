import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetRow } from "@/server/budget/getBudgetGrid";
import { getTargetFillMonths } from "@/ui/tables/budget/budgetTableLogic";
import {
  consumeBudgetBaseLocalAcknowledgement,
  getCurrentBudgetBaseMutationCells,
  getBudgetBaseCellKey,
  issueBudgetBaseMutation,
  protectBudgetBaseAcknowledgement,
  publishBudgetBaseLocalAcknowledgements,
  reconcileBudgetBaseRange,
  retainProtectedBudgetBaseLocalAcknowledgements,
  type BudgetBaseAcknowledgementProtection,
  type BudgetBaseCell,
  type BudgetBaseProtectionByCell,
} from "@/ui/tables/budget/budgetBaseRangeReconciliation";

const makeRow = (
  month: string,
  plannedBase: number,
): BudgetRow => ({
  month,
  direction: "spend",
  category: "Groceries",
  plannedBase,
  plannedModifier: -10,
  planned: plannedBase - 10,
  actual: 20,
  hasUnconvertible: false,
});

const protect = (
  value: number,
  throughRequestGeneration: number,
): BudgetBaseProtectionByCell => {
  const protection: BudgetBaseAcknowledgementProtection = {
    cell: {
      month: "2026-08",
      direction: "spend",
      category: "Groceries",
    },
    value,
    throughRequestGeneration,
  };
  return protectBudgetBaseAcknowledgement(new Map(), protection);
};

test("an acknowledged Base survives a stale response captured by an older request", (): void => {
  const reconciled = reconcileBudgetBaseRange(
    [makeRow("2026-08", 100)],
    protect(250, 3),
    { generation: 3, monthFrom: "2026-07", monthTo: "2026-09" },
  );

  assert.equal(reconciled.rows[0]?.plannedBase, 250);
  assert.equal(reconciled.rows[0]?.planned, 240);
  assert.equal(reconciled.protections.size, 1);
});

test("stale protection restores an acknowledged row missing from the response", (): void => {
  const reconciled = reconcileBudgetBaseRange(
    [],
    protect(250, 3),
    { generation: 2, monthFrom: "2026-08", monthTo: "2026-08" },
  );

  assert.deepEqual(reconciled.rows, [{
    month: "2026-08",
    direction: "spend",
    category: "Groceries",
    plannedBase: 250,
    plannedModifier: 0,
    planned: 250,
    actual: 0,
    hasUnconvertible: false,
  }]);
  assert.equal(reconciled.protections.size, 1);
});

test("a newer authoritative generation retires protection and accepts an older numeric value", (): void => {
  const olderValue = 100;
  const reconciled = reconcileBudgetBaseRange(
    [makeRow("2026-08", olderValue)],
    protect(250, 3),
    { generation: 4, monthFrom: "2026-08", monthTo: "2026-08" },
  );

  assert.equal(reconciled.rows[0]?.plannedBase, olderValue);
  assert.equal(reconciled.protections.size, 0);
});

test("a response for another month does not retire Base protection", (): void => {
  const protections = protect(250, 3);
  const rows = [makeRow("2026-07", 100)];
  const reconciled = reconcileBudgetBaseRange(
    rows,
    protections,
    { generation: 4, monthFrom: "2026-07", monthTo: "2026-07" },
  );

  assert.equal(reconciled.rows, rows);
  assert.equal(reconciled.protections.size, 1);
});

test("successful Fill publishes the source value to every target with one local version", (): void => {
  const sourceBase = 451;
  const previousTargetBase = 125;
  const sourceCell: BudgetBaseCell = {
    month: "2026-07",
    direction: "spend",
    category: "Groceries",
  };
  const targetCells = getTargetFillMonths(sourceCell.month).map(
    (month): BudgetBaseCell => ({ ...sourceCell, month }),
  );
  const firstTargetCell = targetCells[0];
  if (firstTargetCell === undefined) {
    throw new Error("Fill must produce at least one target month");
  }
  const existing = publishBudgetBaseLocalAcknowledgements(
    new Map(),
    [firstTargetCell],
    previousTargetBase,
    1,
  );

  const published = publishBudgetBaseLocalAcknowledgements(
    existing,
    targetCells,
    sourceBase,
    2,
  );

  for (const cell of targetCells) {
    assert.deepEqual(
      published.get(getBudgetBaseCellKey(cell)),
      { value: sourceBase, version: 2 },
    );
  }
  assert.equal(published.has(getBudgetBaseCellKey(sourceCell)), false);
  assert.notEqual(sourceBase, previousTargetBase);
});

test("a late Base acknowledgement cannot supersede a later Fill mutation", (): void => {
  const sourceCell: BudgetBaseCell = {
    month: "2026-07",
    direction: "spend",
    category: "Groceries",
  };
  const targetCells = getTargetFillMonths(sourceCell.month).map(
    (month): BudgetBaseCell => ({ ...sourceCell, month }),
  );
  const targetCell = targetCells[0];
  if (targetCell === undefined) {
    throw new Error("Fill must produce at least one target month");
  }

  const baseMutation = issueBudgetBaseMutation(0, new Map(), [targetCell]);
  const fillMutation = issueBudgetBaseMutation(
    baseMutation.generation,
    baseMutation.generationByCell,
    targetCells,
  );
  const currentFillCells = getCurrentBudgetBaseMutationCells(
    fillMutation.generationByCell,
    targetCells,
    fillMutation.generation,
  );
  let acknowledgements = publishBudgetBaseLocalAcknowledgements(
    new Map(),
    currentFillCells,
    451,
    fillMutation.generation,
  );

  const lateBaseCells = getCurrentBudgetBaseMutationCells(
    fillMutation.generationByCell,
    [targetCell],
    baseMutation.generation,
  );
  if (lateBaseCells.length > 0) {
    acknowledgements = publishBudgetBaseLocalAcknowledgements(
      acknowledgements,
      lateBaseCells,
      125,
      baseMutation.generation,
    );
  }

  assert.deepEqual(lateBaseCells, []);
  assert.deepEqual(
    acknowledgements.get(getBudgetBaseCellKey(targetCell)),
    { value: 451, version: fillMutation.generation },
  );
});

test("a target editor consumes only a newer local acknowledgement", (): void => {
  const targetBase = 125;
  const fillAcknowledgement = { value: 451, version: 2 };

  assert.deepEqual(
    consumeBudgetBaseLocalAcknowledgement(
      targetBase,
      fillAcknowledgement,
      1,
    ),
    { value: 451, version: 2 },
  );
  assert.deepEqual(
    consumeBudgetBaseLocalAcknowledgement(
      targetBase,
      fillAcknowledgement,
      2,
    ),
    { value: targetBase, version: 2 },
  );
});

test("a newer authoritative response retires the matching local publication", (): void => {
  const cell: BudgetBaseCell = {
    month: "2026-08",
    direction: "spend",
    category: "Groceries",
  };
  const acknowledgements = publishBudgetBaseLocalAcknowledgements(
    new Map(),
    [cell],
    451,
    2,
  );

  assert.equal(
    retainProtectedBudgetBaseLocalAcknowledgements(
      acknowledgements,
      new Map(),
    ).size,
    0,
  );
});
