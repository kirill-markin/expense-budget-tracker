export const escapeHtml = (value: string): string => value
  .replace(/&/gu, "&amp;")
  .replace(/</gu, "&lt;")
  .replace(/>/gu, "&gt;")
  .replace(/"/gu, "&quot;")
  .replace(/'/gu, "&#39;");
