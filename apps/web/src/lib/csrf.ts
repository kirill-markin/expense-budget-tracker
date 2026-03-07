"use client";

const CSRF_COOKIE_NAME = "__Host-csrf";
const CSRF_HEADER_NAME = "X-CSRF-Token";

const getCookieValue = (name: string): string | null => {
  const parts = document.cookie.split("; ");
  for (const part of parts) {
    if (part.startsWith(`${name}=`)) {
      return decodeURIComponent(part.slice(name.length + 1));
    }
  }
  return null;
};

export const getCsrfToken = (): string => {
  if (typeof document === "undefined") {
    throw new Error("CSRF token is only available in the browser");
  }
  const token = getCookieValue(CSRF_COOKIE_NAME);
  if (token === null || token === "") {
    throw new Error("Missing CSRF token cookie");
  }
  return token;
};

export const fetchWithCsrf = (input: RequestInfo | URL, init: RequestInit): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set(CSRF_HEADER_NAME, getCsrfToken());
  return fetch(input, { ...init, headers });
};
