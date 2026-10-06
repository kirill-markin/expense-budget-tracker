/**
 * State tokens a year-total cell carries, in the order they are applied.
 *
 * `isWarning` marks a value that could not be fully converted to the report
 * currency; `isOver` a genuine over-plan or negative value. Red wins over
 * yellow: a value that is both keeps the danger background, never the warning
 * one, so "untrusted" never hides a real over-plan.
 */
export type YearTotalStateToken = "warning" | "over" | "danger" | "warningBackground";

export const resolveYearTotalStateTokens = (
  isWarning: boolean,
  isOver: boolean,
): ReadonlyArray<YearTotalStateToken> => {
  const tokens: YearTotalStateToken[] = [];

  if (isWarning) {
    tokens.push("warning");
  }

  if (isOver) {
    tokens.push("over");
    tokens.push("danger");
  } else if (isWarning) {
    tokens.push("warningBackground");
  }

  return tokens;
};
