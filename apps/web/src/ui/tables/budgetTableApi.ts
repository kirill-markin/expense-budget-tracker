import type { BudgetGridResult } from "@/server/budget/getBudgetGrid";

export const fetchBudgetRange = async (monthFrom: string, monthTo: string, planFrom: string, actualTo: string): Promise<BudgetGridResult> => {
  const url = `/api/budget-grid?monthFrom=${encodeURIComponent(monthFrom)}&monthTo=${encodeURIComponent(monthTo)}&planFrom=${encodeURIComponent(planFrom)}&actualTo=${encodeURIComponent(actualTo)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Budget API error: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<BudgetGridResult>;
};

export const postBudgetPlan = async (params: {
  month: string;
  direction: string;
  category: string;
  kind: "base" | "modifier";
  plannedValue: number;
}): Promise<void> => {
  const response = await fetch("/api/budget-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Budget plan update failed: ${response.status} ${await response.text()}`);
  }
};

export const postBudgetPlanFill = async (params: {
  fromMonth: string;
  direction: string;
  category: string;
  baseValue: number;
}): Promise<void> => {
  const response = await fetch("/api/budget-plan-fill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Budget plan fill failed: ${response.status} ${await response.text()}`);
  }
};

export const fetchComment = async (month: string, direction: string, category: string): Promise<string | null> => {
  const params = new URLSearchParams({ month, direction, category });
  const response = await fetch(`/api/budget-comment?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Comment fetch failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json() as { comment: string | null };
  return data.comment;
};

export const postComment = async (params: {
  month: string;
  direction: string;
  category: string;
  comment: string;
}): Promise<void> => {
  const response = await fetch("/api/budget-comment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Comment save failed: ${response.status} ${await response.text()}`);
  }
};
