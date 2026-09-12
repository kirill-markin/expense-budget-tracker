"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import type { AccountMentionSuggestion } from "./accountMentions";

const accountSuggestionSchema = z.object({
  accountId: z.string(),
  currency: z.string(),
}).strict();

const accountSuggestionsSchema = z.array(accountSuggestionSchema);

export type AccountSuggestionsState = Readonly<{
  status: "loading" | "loaded" | "error";
  suggestions: ReadonlyArray<AccountMentionSuggestion>;
  errorMessage: string | null;
}>;

const INITIAL_STATE: AccountSuggestionsState = {
  status: "loading",
  suggestions: [],
  errorMessage: null,
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const loadAccountSuggestions = async (): Promise<ReadonlyArray<AccountMentionSuggestion>> => {
  const response = await fetch("/api/account-suggestions", {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Account suggestions request failed with status ${response.status}: ${responseBody}`,
    );
  }

  const payload: unknown = await response.json();
  const parsed = accountSuggestionsSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid account suggestions response: ${details}`);
  }

  return parsed.data;
};

export const useAccountSuggestions = (): Readonly<{
  state: AccountSuggestionsState;
  refresh: () => void;
}> => {
  const [state, setState] = useState<AccountSuggestionsState>(INITIAL_STATE);
  const requestRef = useRef<Promise<ReadonlyArray<AccountMentionSuggestion>> | null>(null);
  const requestSequenceRef = useRef<number>(0);

  // Only the newest request writes state; a refresh keeps the current list
  // visible until its response arrives.
  const trackRequest = useCallback((
    request: Promise<ReadonlyArray<AccountMentionSuggestion>>,
  ): void => {
    requestSequenceRef.current += 1;
    const sequence = requestSequenceRef.current;

    void request.then((suggestions): void => {
      if (sequence !== requestSequenceRef.current) return;
      setState({ status: "loaded", suggestions, errorMessage: null });
    }).catch((error: unknown): void => {
      if (sequence !== requestSequenceRef.current) return;
      setState({
        status: "error",
        suggestions: [],
        errorMessage: getErrorMessage(error),
      });
    });
  }, []);

  useEffect(() => {
    const request = requestRef.current ?? loadAccountSuggestions();
    requestRef.current = request;
    trackRequest(request);

    return () => {
      // Discards every in-flight response after unmount.
      requestSequenceRef.current += 1;
    };
  }, [trackRequest]);

  const refresh = useCallback((): void => {
    trackRequest(loadAccountSuggestions());
  }, [trackRequest]);

  return { state, refresh };
};
