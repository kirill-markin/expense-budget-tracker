import assert from "node:assert/strict";
import test from "node:test";

import {
  findAccountMentionTrigger,
  formatAccountMention,
  rankAccountSuggestions,
  replaceAccountMention,
  type AccountMentionSuggestion,
} from "./accountMentions";

const SUGGESTIONS: ReadonlyArray<AccountMentionSuggestion> = [
  { accountId: "recent-savings-usd", currency: "USD" },
  { accountId: "Checking-EUR", currency: "EUR" },
  { accountId: "older-checking-usd", currency: "USD" },
  { accountId: "cash-eur", currency: "EUR" },
];

test("detects only eligible bare mentions containing the caret", (): void => {
  assert.deepEqual(findAccountMentionTrigger("@check", 6), {
    start: 0,
    end: 6,
    query: "check",
    isQuoted: false,
  });
  assert.deepEqual(findAccountMentionTrigger("Pay from @cash-eur today", 14), {
    start: 9,
    end: 18,
    query: "cash",
    isQuoted: false,
  });
  assert.equal(findAccountMentionTrigger("Pay from @cash-eur today", 24), null);
  assert.deepEqual(findAccountMentionTrigger("Use @account_2 next", 14), {
    start: 4,
    end: 14,
    query: "account_2",
    isQuoted: false,
  });
});

test("ignores email-like, escaped, and non-boundary at signs", (): void => {
  assert.equal(findAccountMentionTrigger("person@example.com", 14), null);
  assert.equal(findAccountMentionTrigger("ignore \\@checking-usd", 21), null);
  assert.equal(findAccountMentionTrigger("prefix@checking-usd", 19), null);
});

test("detects repeated mentions independently", (): void => {
  const text = "Move from @checking-usd to @savings-usd";
  assert.deepEqual(findAccountMentionTrigger(text, 19), {
    start: 10,
    end: 23,
    query: "checking",
    isQuoted: false,
  });
  assert.deepEqual(findAccountMentionTrigger(text, text.length), {
    start: 27,
    end: 39,
    query: "savings-usd",
    isQuoted: false,
  });
});

test("decodes quoted mention queries with spaces and JSON escapes", (): void => {
  const text = 'Use @"Main \\"Wallet\\" \\u20ac" now';
  const closingQuote = text.lastIndexOf('"');
  assert.deepEqual(findAccountMentionTrigger(text, closingQuote), {
    start: 4,
    end: closingQuote + 1,
    query: 'Main "Wallet" €',
    isQuoted: true,
  });
  assert.deepEqual(findAccountMentionTrigger('Use @"Account name', 18), {
    start: 4,
    end: 18,
    query: "Account name",
    isQuoted: true,
  });
  assert.equal(findAccountMentionTrigger('Use @"bad\\q', 11), null);
  assert.deepEqual(findAccountMentionTrigger('Use @"Main @Wallet', 18), {
    start: 4,
    end: 18,
    query: "Main @Wallet",
    isQuoted: true,
  });
});

test("ranks prefix matches before substring matches without changing group order", (): void => {
  assert.deepEqual(
    rankAccountSuggestions(SUGGESTIONS, "CHECK"),
    [SUGGESTIONS[1], SUGGESTIONS[2]],
  );
  assert.deepEqual(rankAccountSuggestions(SUGGESTIONS, "eur"), [
    SUGGESTIONS[1],
    SUGGESTIONS[3],
  ]);
  assert.equal(rankAccountSuggestions(SUGGESTIONS, ""), SUGGESTIONS);
});

test("formats safe IDs bare and quotes unsafe IDs with JSON escaping", (): void => {
  assert.equal(formatAccountMention("checking-usd_2"), "@checking-usd_2");
  assert.equal(
    formatAccountMention('Main "Wallet" \\ EUR'),
    '@"Main \\"Wallet\\" \\\\ EUR"',
  );
  assert.throws(() => formatAccountMention(""), /empty account ID/);
});

test("replaces only the active mention and returns the restored caret", (): void => {
  const text = "Move @chec to @savings-usd";
  const trigger = findAccountMentionTrigger(text, 10);
  assert.notEqual(trigger, null);
  if (trigger === null) return;

  assert.deepEqual(replaceAccountMention(text, trigger, "checking-usd"), {
    text: "Move @checking-usd to @savings-usd",
    caretPosition: 18,
  });
});

test("adds one trailing space at the end and preserves an existing separator", (): void => {
  const endTrigger = findAccountMentionTrigger("Pay @sav", 8);
  assert.notEqual(endTrigger, null);
  if (endTrigger === null) return;
  assert.deepEqual(replaceAccountMention("Pay @sav", endTrigger, "savings-usd"), {
    text: "Pay @savings-usd ",
    caretPosition: 17,
  });

  const punctuationTrigger = findAccountMentionTrigger("Pay @sav, please", 8);
  assert.notEqual(punctuationTrigger, null);
  if (punctuationTrigger === null) return;
  assert.deepEqual(replaceAccountMention("Pay @sav, please", punctuationTrigger, "Savings EUR"), {
    text: 'Pay @"Savings EUR", please',
    caretPosition: 18,
  });
});

test("rejects caret positions outside the text", (): void => {
  assert.throws(
    () => findAccountMentionTrigger("@account", 20),
    /outside text length/,
  );
});
