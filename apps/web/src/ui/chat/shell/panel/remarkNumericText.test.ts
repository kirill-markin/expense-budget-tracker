import assert from "node:assert/strict";
import test from "node:test";

import type { PhrasingContent, Root } from "mdast";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { remarkNumericText } from "./remarkNumericText";

const paragraph = (children: PhrasingContent[]): Root => ({
  type: "root",
  children: [{ type: "paragraph", children }],
});

const isolated = (value: string): PhrasingContent => ({
  type: "emphasis",
  data: { hName: "bdi", hProperties: { dir: "ltr" } },
  children: [{ type: "text", value }],
});

const transform = remarkNumericText();

test("isolates signed amounts, currencies, percentages, ranges and native digits", (): void => {
  for (const value of ["-123,456,789", "+12.5%", "$-1,234.56", "−۱۲۳٬۴۵۶٫۷۸", "10–20", "-10 - -5", "2026-11-13", "1\u00a0234,56 €"]) {
    assert.deepEqual(transform(paragraph([{ type: "text", value }])), paragraph([isolated(value)]), value);
  }
});

test("preserves surrounding Hebrew prose, formatting, code and input tree", (): void => {
  const input = paragraph([
    { type: "text", value: "יתרה: " },
    { type: "strong", children: [{ type: "text", value: "-123.45" }] },
    { type: "text", value: " בסך הכל" },
    { type: "inlineCode", value: "amount=-123.45" },
  ]);
  const snapshot = structuredClone(input);
  assert.deepEqual(transform(input), paragraph([
    { type: "text", value: "יתרה: " },
    { type: "strong", children: [isolated("-123.45")] },
    { type: "text", value: " בסך הכל" },
    { type: "inlineCode", value: "amount=-123.45" },
  ]));
  assert.deepEqual(input, snapshot);
});

test("does not split identifiers or rewrite code blocks", (): void => {
  const input: Root = {
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "text", value: "account123 abc123def v2" }] },
      { type: "code", value: "-123.45", lang: "sql" },
    ],
  };
  assert.deepEqual(transform(input), input);
});

test("marks a sign after an Arabic direction mark and preserves the amount in prose and tables", (): void => {
  const amount = "\u061c-١٢٣٫٤٥٪";
  const markedAmount = `<bdi dir="ltr" data-preserve-number-order="">${amount}</bdi>`;
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkNumericText],
    children: `الرصيد: ${amount} اليوم. الإجمالي: ٢٠٠ يورو.\n\n| المبلغ |\n| --- |\n| ${amount} |`,
  }));
  assert.ok(html.includes(`<p>الرصيد: ${markedAmount} اليوم. الإجمالي: <bdi dir="ltr">٢٠٠</bdi> يورو.</p>`));
  assert.ok(html.includes(`<td>${markedAmount}</td>`));
});

test("preserves signed endpoint order without overriding the rest of an Arabic range", (): void => {
  const amount = "\u061c-٥";
  const lateSign = `١٠–${amount}`;
  const earlySign = `${amount}–﷼123`;
  const markedAmount = `<bdi dir="ltr" data-preserve-number-order="">${amount}</bdi>`;
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkNumericText],
    children: `النطاق: ${lateSign} اليوم.\n\n| النطاق |\n| --- |\n| ${earlySign} |`,
  }));
  assert.ok(html.includes(`<p>النطاق: <bdi dir="ltr">١٠–${markedAmount}</bdi> اليوم.</p>`));
  assert.ok(html.includes(`<td><bdi dir="ltr">${markedAmount}–﷼123</bdi></td>`));
});

test("uses ordinary isolation for unsigned currencies and percentages", (): void => {
  const percent = "٢٥٪\u061c";
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkNumericText],
    children: `Price: ﷼123. Share: ${percent}.`,
  }));
  assert.equal(html, `<p>Price: <bdi dir="ltr">﷼123</bdi>. Share: <bdi dir="ltr">${percent}</bdi>.</p>`);
});

test("renders bdi in Markdown tables and preserves link destinations", (): void => {
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkNumericText],
    children: "| סכום |\n| --- |\n| -123.45 |\n\n[+12%](https://example.com/123)",
  }));
  assert.match(html, /<td><bdi dir="ltr">-123\.45<\/bdi><\/td>/);
  assert.match(html, /href="https:\/\/example.com\/123"><bdi dir="ltr">\+12%<\/bdi>/);
  assert.doesNotMatch(html, /<em>/);
});
