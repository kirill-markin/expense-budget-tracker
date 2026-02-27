/**
 * Dynamic demo data generator. Data is generated relative to the current month
 * so the demo always looks fresh. To adjust: edit PATTERNS, TRANSFERS, or BUDGET_PLAN.
 */
import type { AccountRow, BalancesSummaryResult, CurrencyTotal } from "@/server/balances/getBalancesSummary";
import type { BudgetGridResult, BudgetRow } from "@/server/budget/getBudgetGrid";
import type { CommentedCell } from "@/server/budget/getCommentedCells";
import type { FxBreakdownResult, FxBreakdownRow } from "@/server/budget/getFxBreakdown";
import type { AccountOption, FieldHints, LedgerEntry, TransactionsFilter, TransactionsPage } from "@/server/transactions/getTransactions";
import { generateMonthRange, getCurrentMonth, offsetMonth } from "@/lib/monthUtils";

// ---------------------------------------------------------------------------
// Config — edit these to change demo content
// ---------------------------------------------------------------------------

const FX: Readonly<Record<string, number>> = { USD: 1, EUR: 1.029, GBP: 1.24 };
const PAST_MONTHS = 12;
const FUTURE_MONTHS = 12;

type Pattern = Readonly<{
  account: string;
  currency: string;
  kind: "income" | "spend";
  category: string;
  counterparty: string;
  amount: number;
  jitter: number;
  day: number;
  every: number;
  offset: number;
}>;

// Each pattern fires when (monthIndex % every === offset). monthIndex 0 = oldest, 11 = current.
const PATTERNS: ReadonlyArray<Pattern> = [
  { account: "checking-usd", currency: "USD", kind: "income", category: "Salary",        counterparty: "Employer Inc",  amount: 5000,  jitter: 0,   day: 5,  every: 1, offset: 0 },
  { account: "checking-eur", currency: "EUR", kind: "income", category: "Freelance",     counterparty: "Client GmbH",   amount: 800,   jitter: 200, day: 20, every: 3, offset: 0 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Rent",          counterparty: "Landlord LLC",  amount: -1500, jitter: 0,   day: 1,  every: 1, offset: 0 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Groceries",     counterparty: "Whole Foods",   amount: -150,  jitter: 50,  day: 8,  every: 1, offset: 0 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Dining",        counterparty: "Restaurant",    amount: -80,   jitter: 30,  day: 18, every: 1, offset: 0 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Utilities",     counterparty: "Electric Co",   amount: -180,  jitter: 40,  day: 12, every: 1, offset: 0 },
  { account: "checking-gbp", currency: "GBP", kind: "spend",  category: "Subscriptions", counterparty: "Streaming Co",  amount: -30,   jitter: 0,   day: 10, every: 1, offset: 0 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Transport",     counterparty: "Uber",          amount: -45,   jitter: 20,  day: 16, every: 2, offset: 0 },
  { account: "checking-eur", currency: "EUR", kind: "spend",  category: "Transport",     counterparty: "Deutsche Bahn", amount: -40,   jitter: 10,  day: 15, every: 2, offset: 1 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Entertainment", counterparty: "Cinema",        amount: -100,  jitter: 30,  day: 22, every: 3, offset: 1 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Healthcare",    counterparty: "City Medical",  amount: -200,  jitter: 80,  day: 20, every: 4, offset: 2 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Clothing",      counterparty: "Nordstrom",     amount: -180,  jitter: 70,  day: 25, every: 4, offset: 0 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Future taxes",  counterparty: "IRS estimated", amount: -800,  jitter: 0,   day: 15, every: 1, offset: 0 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Big purchases", counterparty: "Apple Store",   amount: -1800, jitter: 300, day: 20, every: 11, offset: 2 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Big purchases", counterparty: "IKEA",          amount: -950,  jitter: 200, day: 10, every: 11, offset: 9 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Gifts",         counterparty: "Amazon",        amount: -120,  jitter: 50,  day: 14, every: 3, offset: 1 },
  { account: "checking-usd", currency: "USD", kind: "income", category: "Other",         counterparty: "Cash Back",     amount: 35,    jitter: 15,  day: 25, every: 2, offset: 1 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Other",         counterparty: "Misc Purchase", amount: -45,   jitter: 20,  day: 19, every: 2, offset: 0 },
  { account: "checking-eur", currency: "EUR", kind: "spend",  category: "Other",         counterparty: "Misc",          amount: -25,   jitter: 10,  day: 23, every: 4, offset: 2 },
  { account: "checking-usd", currency: "USD", kind: "income", category: "Adjustment",    counterparty: "Balance correction", amount: 22, jitter: 12, day: 28, every: 6, offset: 3 },
  { account: "checking-usd", currency: "USD", kind: "spend",  category: "Adjustment",    counterparty: "Balance correction", amount: -15, jitter: 8, day: 28, every: 6, offset: 0 },
];

type Transfer = Readonly<{
  from: string; to: string;
  fromCur: string; toCur: string;
  fromAmt: number; toAmt: number;
  day: number; every: number; offset: number;
}>;

const TRANSFERS: ReadonlyArray<Transfer> = [
  { from: "checking-usd", to: "savings-usd",  fromCur: "USD", toCur: "USD", fromAmt: -2000, toAmt: 2000, day: 15, every: 3, offset: 1 },
  { from: "checking-usd", to: "checking-gbp", fromCur: "USD", toCur: "GBP", fromAmt: -500,  toAmt: 400,  day: 8,  every: 6, offset: 3 },
];

const BUDGET_PLAN: ReadonlyArray<Readonly<{ direction: string; category: string; planned: number }>> = [
  { direction: "income", category: "Salary",        planned: 5000 },
  { direction: "income", category: "Freelance",     planned: 500 },
  { direction: "spend",  category: "Rent",           planned: 1500 },
  { direction: "spend",  category: "Groceries",      planned: 400 },
  { direction: "spend",  category: "Dining",          planned: 200 },
  { direction: "spend",  category: "Utilities",       planned: 200 },
  { direction: "spend",  category: "Subscriptions",   planned: 50 },
  { direction: "spend",  category: "Transport",       planned: 100 },
  { direction: "spend",  category: "Entertainment",   planned: 100 },
  { direction: "spend",  category: "Healthcare",      planned: 150 },
  { direction: "spend",  category: "Clothing",        planned: 200 },
  { direction: "spend",  category: "Future taxes",    planned: 800 },
  { direction: "spend",  category: "Big purchases",   planned: 300 },
  { direction: "spend",  category: "Gifts",           planned: 100 },
  { direction: "income", category: "Other",            planned: 20 },
  { direction: "spend",  category: "Other",            planned: 50 },
  { direction: "income", category: "Adjustment",       planned: 0 },
  { direction: "spend",  category: "Adjustment",       planned: 0 },
];

const ACCOUNT_CURRENCIES: Readonly<Record<string, string>> = {
  "checking-usd": "USD", "checking-eur": "EUR", "checking-gbp": "GBP", "savings-usd": "USD",
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const MONTH_ABBRS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const hash = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
};

const vary = (month: string, idx: number, range: number): number =>
  range === 0 ? 0 : (Math.abs(hash(`${month}${idx}`)) % (range * 2 + 1)) - range;

const round2 = (n: number): number => Math.round(n * 100) / 100;

const noteFor = (category: string, monthAbbr: string): string | null => {
  if (category === "Salary") return `${monthAbbr} salary`;
  if (category === "Rent") return `${monthAbbr} rent`;
  if (category === "Utilities") return `${monthAbbr} electricity`;
  if (category === "Freelance") return "Consulting";
  if (category === "Subscriptions") return "Monthly plan";
  if (category === "Future taxes") return `${monthAbbr} estimated taxes`;
  if (category === "Gifts") return "Gift";
  if (category === "Adjustment") return "Balance correction";
  return null;
};

// ---------------------------------------------------------------------------
// Generator (memoized per month)
// ---------------------------------------------------------------------------

type DemoData = Readonly<{
  entries: ReadonlyArray<LedgerEntry>;
  accounts: ReadonlyArray<AccountRow>;
  totals: ReadonlyArray<CurrencyTotal>;
  budgetRows: ReadonlyArray<BudgetRow>;
  monthEndBalances: Readonly<Record<string, number>>;
  currencyNative: Readonly<Record<string, Readonly<Record<string, number>>>>;
}>;

let cached: { month: string; data: DemoData } | null = null;

const generate = (): DemoData => {
  const now = getCurrentMonth();
  if (cached !== null && cached.month === now) return cached.data;

  const pastMonths = Array.from({ length: PAST_MONTHS }, (_, i) => offsetMonth(now, i - PAST_MONTHS + 1));
  const entries: Array<LedgerEntry> = [];
  const actuals = new Map<string, number>();
  const accBal: Record<string, number> = { "checking-usd": 0, "checking-eur": 0, "checking-gbp": 0, "savings-usd": 0 };
  const monthEndBal: Record<string, number> = {};
  const curNative: Record<string, Record<string, number>> = {};
  let entryN = 0;
  let eventN = 0;

  monthEndBal[offsetMonth(pastMonths[0], -1)] = 0;
  curNative[offsetMonth(pastMonths[0], -1)] = { USD: 0, EUR: 0, GBP: 0 };

  for (let mi = 0; mi < pastMonths.length; mi++) {
    const month = pastMonths[mi];
    const [y, m] = month.split("-").map(Number);
    const abbr = MONTH_ABBRS[m - 1];

    for (let pi = 0; pi < PATTERNS.length; pi++) {
      const p = PATTERNS[pi];
      if (mi % p.every !== p.offset) continue;
      const amount = p.amount + vary(month, pi, p.jitter);
      const rate = FX[p.currency] ?? 1;
      const amountUsd = round2(amount * rate);
      entries.push({
        entryId: `d${String(++entryN).padStart(3, "0")}`,
        eventId: `ev${String(++eventN).padStart(3, "0")}`,
        ts: new Date(Date.UTC(y, m - 1, Math.min(p.day, 28), 9 + (pi % 12))).toISOString(),
        accountId: p.account, amount, amountUsd, currency: p.currency,
        kind: p.kind, category: p.category, counterparty: p.counterparty, note: noteFor(p.category, abbr),
      });
      accBal[p.account] = round2((accBal[p.account] ?? 0) + amount);
      const key = `${month}|${p.kind}|${p.category}`;
      actuals.set(key, round2((actuals.get(key) ?? 0) + amountUsd));
    }

    let transferNet = 0;
    for (let ti = 0; ti < TRANSFERS.length; ti++) {
      const t = TRANSFERS[ti];
      if (mi % t.every !== t.offset) continue;
      const evId = `ev${String(++eventN).padStart(3, "0")}`;
      const ts = new Date(Date.UTC(y, m - 1, Math.min(t.day, 28), 8)).toISOString();
      const fromUsd = round2(t.fromAmt * (FX[t.fromCur] ?? 1));
      const toUsd = round2(t.toAmt * (FX[t.toCur] ?? 1));
      entries.push(
        { entryId: `d${String(++entryN).padStart(3, "0")}`, eventId: evId, ts, accountId: t.from, amount: t.fromAmt, amountUsd: fromUsd, currency: t.fromCur, kind: "transfer", category: null, counterparty: null, note: `To ${t.to}` },
        { entryId: `d${String(++entryN).padStart(3, "0")}`, eventId: evId, ts, accountId: t.to, amount: t.toAmt, amountUsd: toUsd, currency: t.toCur, kind: "transfer", category: null, counterparty: null, note: `From ${t.from}` },
      );
      accBal[t.from] = round2((accBal[t.from] ?? 0) + t.fromAmt);
      accBal[t.to] = round2((accBal[t.to] ?? 0) + t.toAmt);
      transferNet = round2(transferNet + fromUsd + toUsd);
    }
    actuals.set(`${month}|transfer|`, round2((actuals.get(`${month}|transfer|`) ?? 0) + transferNet));

    let totalUsd = 0;
    const nativeBal: Record<string, number> = { USD: 0, EUR: 0, GBP: 0 };
    for (const [acc, bal] of Object.entries(accBal)) {
      const cur = ACCOUNT_CURRENCIES[acc] ?? "USD";
      nativeBal[cur] = round2((nativeBal[cur] ?? 0) + bal);
      totalUsd = round2(totalUsd + bal * (FX[cur] ?? 1));
    }
    monthEndBal[month] = totalUsd;
    curNative[month] = nativeBal;
  }

  entries.sort((a, b) => (a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : 0));

  // Account rows
  const DEMO_LIQUIDITY: Readonly<Record<string, string>> = { "savings-usd": "medium" };

  const accounts: ReadonlyArray<AccountRow> = Object.entries(ACCOUNT_CURRENCIES)
    .map(([accountId, currency]) => {
      const balance = round2(accBal[accountId] ?? 0);
      return {
        accountId, currency, liquidity: DEMO_LIQUIDITY[accountId] ?? "high",
        status: "active" as const, balance,
        balanceUsd: round2(balance * (FX[currency] ?? 1)),
        lastTransactionTs: entries.find((e) => e.accountId === accountId)?.ts ?? null,
        overdue: false,
      };
    })
    .sort((a, b) => a.accountId.localeCompare(b.accountId));

  // Currency totals
  const curMap: Record<string, { balance: number; usd: number }> = {};
  for (const acc of accounts) {
    const prev = curMap[acc.currency] ?? { balance: 0, usd: 0 };
    curMap[acc.currency] = { balance: round2(prev.balance + acc.balance), usd: round2(prev.usd + (acc.balanceUsd ?? 0)) };
  }
  const totals: ReadonlyArray<CurrencyTotal> = Object.entries(curMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, { balance, usd }]) => ({
      currency, balance,
      balancePositive: balance > 0 ? balance : 0,
      balanceNegative: balance < 0 ? balance : 0,
      balanceUsd: usd, hasUnconvertible: false,
    }));

  // Budget rows (past months with actuals + future months plan-only)
  const allBudgetMonths = [...pastMonths, ...Array.from({ length: FUTURE_MONTHS }, (_, i) => offsetMonth(now, i + 1))];
  const budgetRows: Array<BudgetRow> = [];
  for (const month of allBudgetMonths) {
    const isPast = month <= now;
    for (const bp of BUDGET_PLAN) {
      const key = `${month}|${bp.direction}|${bp.category}`;
      const raw = actuals.get(key) ?? 0;
      const actual = bp.direction === "spend" ? Math.abs(raw) : raw;
      if (bp.planned === 0 && actual === 0) continue;
      budgetRows.push({
        month, direction: bp.direction, category: bp.category,
        plannedBase: bp.planned, plannedModifier: 0, planned: bp.planned,
        actual: isPast ? round2(actual) : 0, hasUnconvertible: false,
      });
    }
    budgetRows.push({
      month, direction: "transfer", category: "",
      plannedBase: 0, plannedModifier: 0, planned: 0,
      actual: isPast ? round2(actuals.get(`${month}|transfer|`) ?? 0) : 0,
      hasUnconvertible: false,
    });
  }

  const data: DemoData = { entries, accounts, totals, budgetRows, monthEndBalances: monthEndBal, currencyNative: curNative };
  cached = { month: now, data };
  return data;
};

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export const getDemoBalancesSummary = (): BalancesSummaryResult => {
  const { accounts, totals } = generate();
  return { accounts, totals, conversionWarnings: [] };
};

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

const SORT_ACCESSORS: Readonly<Record<string, (e: LedgerEntry) => string | number>> = {
  ts: (e) => e.ts,
  accountId: (e) => e.accountId,
  amount: (e) => e.amount,
  amountAbs: (e) => Math.abs(e.amount),
  amountUsdAbs: (e) => Math.abs(e.amountUsd ?? 0),
  currency: (e) => e.currency,
  kind: (e) => e.kind,
  category: (e) => e.category ?? "",
  counterparty: (e) => e.counterparty ?? "",
};

const applyFilter = (entries: ReadonlyArray<LedgerEntry>, filter: TransactionsFilter): ReadonlyArray<LedgerEntry> => {
  let result = entries;
  if (filter.dateFrom !== null) {
    const from = filter.dateFrom + "T00:00:00";
    result = result.filter((e) => e.ts >= from);
  }
  if (filter.dateTo !== null) {
    const to = filter.dateTo + "T23:59:59.999999";
    result = result.filter((e) => e.ts < to);
  }
  if (filter.accountId !== null) result = result.filter((e) => e.accountId === filter.accountId);
  if (filter.kind !== null) result = result.filter((e) => e.kind === filter.kind);
  if (filter.category !== null) {
    result = filter.category === ""
      ? result.filter((e) => e.category === null)
      : result.filter((e) => e.category === filter.category);
  }
  return result;
};

const applySort = (entries: ReadonlyArray<LedgerEntry>, sortKey: string, sortDir: "asc" | "desc"): ReadonlyArray<LedgerEntry> => {
  const accessor = SORT_ACCESSORS[sortKey] ?? SORT_ACCESSORS["ts"];
  const sorted = [...entries].sort((a, b) => {
    const va = accessor(a);
    const vb = accessor(b);
    return va < vb ? -1 : va > vb ? 1 : 0;
  });
  return sortDir === "desc" ? sorted.reverse() : sorted;
};

export const getDemoTransactionsPage = (filter: TransactionsFilter): TransactionsPage => {
  const filtered = applyFilter(generate().entries, filter);
  const sorted = applySort(filtered, filter.sortKey, filter.sortDir);
  return { entries: sorted.slice(filter.offset, filter.offset + filter.limit), total: filtered.length };
};

export const getDemoAccounts = (): ReadonlyArray<AccountOption> =>
  Object.keys(ACCOUNT_CURRENCIES).sort().map((accountId) => ({ accountId }));

export const getDemoCategories = (): ReadonlyArray<string> => {
  const set = new Set<string>();
  for (const entry of generate().entries) {
    if (entry.category !== null) set.add(entry.category);
  }
  return [...set].sort();
};

export const getDemoFieldHints = (): FieldHints => {
  const entries = generate().entries;
  const accounts = new Set<string>();
  const currencies = new Set<string>();
  const counterparties = new Set<string>();
  const notes = new Set<string>();
  for (const e of entries) {
    accounts.add(e.accountId);
    currencies.add(e.currency);
    if (e.counterparty !== null) counterparties.add(e.counterparty);
    if (e.note !== null) notes.add(e.note);
  }
  return {
    accounts: [...accounts].sort(),
    currencies: [...currencies].sort(),
    counterparties: [...counterparties].sort(),
    notes: [...notes].sort(),
  };
};

// ---------------------------------------------------------------------------
// Budget grid
// ---------------------------------------------------------------------------

export const getDemoBudgetGrid = (
  monthFrom: string,
  monthTo: string,
  _planFrom: string,
  _actualTo: string,
): BudgetGridResult => {
  const { budgetRows, monthEndBalances } = generate();
  const months = new Set(generateMonthRange(monthFrom, monthTo));
  return {
    rows: budgetRows.filter((r) => months.has(r.month)),
    conversionWarnings: [],
    cumulativeBefore: { incomeActual: 0, spendActual: 0, transferActual: 0 },
    monthEndBalances,
  };
};

// ---------------------------------------------------------------------------
// Budget comments (relative to current month)
// ---------------------------------------------------------------------------

const COMMENT_TEMPLATES: ReadonlyArray<Readonly<{ monthOffset: number; direction: string; category: string; comment: string }>> = [
  { monthOffset: -1, direction: "spend", category: "Groceries", comment: "Reduced budget due to travel" },
  { monthOffset: 0, direction: "spend", category: "Utilities", comment: "Expected higher bill this month" },
];

const resolveComments = (): ReadonlyArray<Readonly<{ month: string; direction: string; category: string; comment: string }>> => {
  const now = getCurrentMonth();
  return COMMENT_TEMPLATES.map((c) => ({ month: offsetMonth(now, c.monthOffset), direction: c.direction, category: c.category, comment: c.comment }));
};

export const getDemoLatestComment = (params: Readonly<{ month: string; direction: string; category: string }>): string | null =>
  resolveComments().find((c) => c.month === params.month && c.direction === params.direction && c.category === params.category)?.comment ?? null;

export const getDemoCommentedCells = (params: Readonly<{ monthFrom: string; monthTo: string }>): ReadonlyArray<CommentedCell> =>
  resolveComments()
    .filter((c) => c.month >= params.monthFrom && c.month <= params.monthTo)
    .map((c) => ({ month: c.month, direction: c.direction, category: c.category }));

// ---------------------------------------------------------------------------
// FX breakdown
// ---------------------------------------------------------------------------

export const getDemoFxBreakdown = (month: string): FxBreakdownResult => {
  const { currencyNative } = generate();
  const prev = offsetMonth(month, -1);
  const open = currencyNative[prev] ?? { USD: 0, EUR: 0, GBP: 0 };
  const close = currencyNative[month] ?? open;
  const rows: ReadonlyArray<FxBreakdownRow> = (["USD", "EUR", "GBP"] as const).map((cur) => {
    const rate = FX[cur] ?? 1;
    const o = open[cur] ?? 0;
    const c = close[cur] ?? 0;
    return {
      currency: cur, openNative: o, openRate: rate, openUsd: round2(o * rate),
      deltaNative: round2(c - o), closeNative: c, closeRate: rate,
      closeUsd: round2(c * rate), changeUsd: round2((c - o) * rate),
    };
  });
  return { rows };
};
