export const cn = (...classNames: ReadonlyArray<string | false | null | undefined>): string =>
  classNames.filter((className): className is string => typeof className === "string" && className.length > 0).join(" ");
