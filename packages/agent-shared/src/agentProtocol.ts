/**
 * Shared Expenses agent protocol text. Every agent surface composes its own
 * instructions from these constants instead of keeping a private copy.
 */
import {
  ALLOWED_SQL_FUNCTION_NAMES,
  MAX_SQL_MUTATION_ROWS,
  MAX_SQL_RETURNED_ROWS,
  MAX_SQL_ROWS,
} from "./sql-policy.js";

const ALLOWED_SQL_FUNCTIONS_TEXT = ALLOWED_SQL_FUNCTION_NAMES
  .map((name) => name.toUpperCase())
  .join(", ");

export const SQL_DIALECT_GUIDE = `## Restricted SQL dialect

Restricted SQL accepts SELECT, WITH, INSERT, UPDATE, and DELETE. Send one statement per call unless the entrypoint you use documents semicolon-separated scripts.
Relation operations: ledger_entries, budget_lines, workspace_settings, and account_metadata support SELECT and, under existing write-approval rules, INSERT, UPDATE, and DELETE; the derived accounts view and global worker-owned fx_rates_raw and fx_rates_daily relations are SELECT-only. Only allowlisted relations are reachable; internal and security-related relations are blocked.
Only these function calls are supported: ${ALLOWED_SQL_FUNCTIONS_TEXT}. Every other function is blocked, including NOW, LOWER, DATE_TRUNC, gen_random_uuid, set_config, and workspace or auth helper functions.
Use ILIKE instead of LOWER(...) for case-insensitive text matching.
Calculate explicit date literals before running SQL instead of calling NOW() or DATE_TRUNC(), and filter with closed-open ranges: ts >= start date and ts < exclusive end date.
Use regular single-quoted literals and double an embedded apostrophe, for example 'customer''s'. Dollar-quoted strings and E'...' escape strings are not supported.
ON CONFLICT is not supported. Read first, then run an explicit INSERT when the row is missing or an explicit UPDATE when the row already exists.
INSERT statements must set workspace_id explicitly; read it from workspace_settings first.
A SELECT returns at most ${MAX_SQL_ROWS} rows per statement, some entrypoints additionally apply one shared ${MAX_SQL_RETURNED_ROWS}-row returned-row budget across all statements of a single call that SELECT rows and mutation RETURNING rows both consume, and a mutation may affect at most ${MAX_SQL_MUTATION_ROWS} rows per call, so split larger changes into sequential calls.
Every result is JSON with an ok flag; when ok is false, read the error message and fix the statement before retrying. Before treating a result set as complete, compare returnedRowCount with totalRowCount and check truncated, and narrow the query when the result was capped.`;

// Exported because the REST discovery response composes a shorter write excerpt from this section and WRITE_APPROVAL_GUIDE.
export const WRITE_PROTOCOL_INTRO_GUIDE = `## Writing data

Before any write (INSERT, UPDATE, DELETE), describe the exact changes you plan to make and wait for the user's explicit approval. Reads (SELECT) never need approval.
Treat this protocol as session-scoped, not message-scoped. If you already completed a step earlier in the same session and nothing relevant changed, reuse those results instead of repeating the same calls. Repeat a step only when the user provided new data that affects it, a previous result was interrupted or marked unknown, or the database may have changed after a write.`;

const WRITE_DISCOVERY_GUIDE = `### Discovery before writing

Get the existing accounts: SELECT account_id, currency FROM accounts ORDER BY account_id
Read recent entries for the affected accounts, starting from the earliest date in the user's data. This gives category and counterparty context and reveals duplicates. A row is a duplicate when ts, account_id, amount, and counterparty all match an existing row; drop duplicates from the plan immediately.
Categories are free-form text and each user defines their own, so discover them and reuse existing names exactly, case-sensitive:
SELECT kind, category, COUNT(*) AS cnt FROM ledger_entries GROUP BY kind, category ORDER BY kind, cnt DESC
Look up counterparties you cannot categorize in full history, and use the amount as supporting evidence together with description, account, currency, date and time, status, neighboring rows, and historical patterns:
SELECT counterparty, currency, category, kind, COUNT(*) AS cnt, MIN(amount) AS min_amount, MAX(amount) AS max_amount, AVG(amount) AS avg_amount FROM ledger_entries WHERE counterparty ILIKE '%partial_name%' GROUP BY counterparty, currency, category, kind ORDER BY cnt DESC LIMIT 10
Create a new category only when nothing in the user's history fits. Confirm the new name with the user first, unless the user already delegated best-guess decisions for this import.`;

const WRITE_ENTRY_SHAPES_GUIDE = `### Entry shapes

Internal transfer: two rows sharing one event_id, category NULL on both, a negative amount on the source account and a positive amount on the destination account. Cross-currency transfers keep the real amount of each side, so the two amounts differ and the destination amount must be asked for when it is unknown.
Internal currency conversion inside one financial provider is a transfer between that provider's currency accounts; always include both rows.
Split transaction: several rows sharing one event_id, often on the same account, each with its own category and amount, summing to the original statement amount.
Debt repayment is not a transfer. Reimbursement of shared spending is a spend row with the underlying category.
When a transaction currency differs from the account currency shown in the source, use that provider's account in the transaction currency.
Omit generated columns: entry_id and inserted_at are filled by PostgreSQL.`;

const WRITE_SOURCE_ROWS_GUIDE = `### Source rows and dates

Create rows with bank status pending, completed, or preauth. Treat preauth like pending because it often posts later. Skip declined, cancelled, and reverted rows.
If any part of a date or time is missing (day, month, or year), infer the date closest to today. When the inferred date is more than 60 days from today, ask the user to confirm it.`;

const WRITE_CHECKLIST_GUIDE = `### Checklist for every entry

- account_id resolved, including the provider's account in the transaction currency
- kind resolved: income, spend, or transfer
- category resolved from the user's existing categories, or NULL for transfers
- bank status handled
- transfer pairs complete, with both accounts and both amounts
- date and time complete
- not a duplicate`;

const WRITE_QUESTIONS_GUIDE = `### Questions

Collect every unclear point across every entry and ask all of them in a single numbered list with continuous numbering. Never ask questions piecemeal across several messages.
Identify each affected entry by its human-readable details: date and time, merchant or description, signed amount, currency, and human-readable account name when relevant. Use source row numbers, external IDs, and database IDs only for your own matching, deduplication, execution, and resume bookkeeping. Never make the user count rows or translate human names into system identifiers.
Include at least one concise, copyable example answer in the expected format, and say so when one answer can cover a group of entries.`;

// Exported: part of the REST discovery write excerpt; see WRITE_PROTOCOL_INTRO_GUIDE.
export const WRITE_APPROVAL_GUIDE = `### Approval and execution

Show the complete plan before asking for approval: every entry including both sides of each transfer pair, and the balance math for each affected account as current balance plus the sum of new entries equals the expected balance. That balance math is an internal check; ask the user to confirm it against their own view only when it reveals a real mismatch or an unresolved ambiguity.
One explicit approval covers the full approved change set, including the probe and every remaining batch. After approval, execute the probe automatically instead of treating it as a second checkpoint.
Start with a tiny probe in the same SQL shape: 1-3 literal rows for INSERT, 1 targeted row for UPDATE or DELETE. If the probe fails, stop, show the exact error, fix the SQL, and retry the small version. If the probe succeeds, immediately continue with the remaining approved data in sequential batches of at most ${MAX_SQL_MUTATION_ROWS} rows per call, and prefer several sequential calls over one oversized batch.
Do: probe succeeds -> continue with the next batch immediately.
Don't: probe succeeds -> ask "A or B" or request renewed approval unless execution failed or a new ambiguity appeared.
When the user delegates reasonable assumptions, says to use best judgment or best guess, or says decide for me, proceed, or continue, treat unresolved account naming, category naming, and heuristic mapping choices as approved defaults for that import. State the assumptions briefly and keep executing.
Do not write optional sidecar data on your own initiative. Write it only when the user explicitly asks to set or override it.`;

const WRITE_PROGRESS_GUIDE = `### Progress and resuming

Keep an explicit progress ledger for every multi-batch change. Track source row indices or ranges internally when available, otherwise stable source markers such as timestamps, external IDs, or account-specific ordered chunks. In user-facing progress updates, describe checkpoints with batch counts and human-readable boundaries such as dates, descriptions, and amounts instead of raw row numbers or internal IDs.
After each successful probe or batch, state which checkpoint is completed and which one is next pending. Never claim a checkpoint as completed before its call succeeded.
On a later message such as "continue", do not restart planning. Resume from the last explicitly completed checkpoint recorded in the same session unless a fresh read proves that checkpoint is wrong. After an interruption, reconcile the last completed checkpoint from earlier results and your own progress notes first, then continue from the next unfinished checkpoint.`;

const WRITE_FINAL_VERIFICATION_GUIDE = `### Final verification

The final stage of any import is checksum verification. After the last write batch, read fresh data to verify how many rows were added and what balance each affected account now has:
SELECT SUM(amount) AS balance FROM ledger_entries WHERE account_id = 'TARGET_ACCOUNT'
If a resulting balance is negative, or this looks like the first import for that account, it is worth clarifying the real current balance with the user. When imported history does not line up with the user's real balance, you may suggest a backdated adjustment entry so the account balance matches reality.
If the checksum does not match after fresh reads, compare day totals to localize the difference, show the exact affected entries with human-readable details, and fix only the inconsistent rows with targeted changes. Ask the user before broad, ambiguous, or destructive deletion.`;

export const WRITING_DATA_GUIDE = [
  WRITE_PROTOCOL_INTRO_GUIDE,
  WRITE_DISCOVERY_GUIDE,
  WRITE_ENTRY_SHAPES_GUIDE,
  WRITE_SOURCE_ROWS_GUIDE,
  WRITE_CHECKLIST_GUIDE,
  WRITE_QUESTIONS_GUIDE,
  WRITE_APPROVAL_GUIDE,
  WRITE_PROGRESS_GUIDE,
  WRITE_FINAL_VERIFICATION_GUIDE,
].join("\n\n");
