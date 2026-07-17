"use client";

import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";

type TableEditorActivationContextValue = Readonly<{
  requestActivation: (editorId: string) => boolean;
  releaseActivation: (editorId: string) => void;
}>;

const TableEditorActivationContext = createContext<TableEditorActivationContextValue | null>(null);

type ProviderProps = Readonly<{
  children: ReactNode;
}>;

export const TableEditorActivationProvider = (props: ProviderProps): ReactElement => {
  const activeEditorIdRef = useRef<string | null>(null);

  const requestActivation = useCallback((editorId: string): boolean => {
    const activeEditorId = activeEditorIdRef.current;
    if (activeEditorId !== null && activeEditorId !== editorId) return false;
    activeEditorIdRef.current = editorId;
    return true;
  }, []);

  const releaseActivation = useCallback((editorId: string): void => {
    if (activeEditorIdRef.current === editorId) {
      activeEditorIdRef.current = null;
    }
  }, []);

  const value = useMemo<TableEditorActivationContextValue>(
    () => ({ requestActivation, releaseActivation }),
    [releaseActivation, requestActivation],
  );

  return (
    <TableEditorActivationContext value={value}>
      {props.children}
    </TableEditorActivationContext>
  );
};

type TableEditorActivation = Readonly<{
  requestActivation: () => boolean;
  releaseActivation: () => void;
}>;

export const useTableEditorActivation = (editorId: string): TableEditorActivation => {
  const context = useContext(TableEditorActivationContext);
  if (context === null) {
    throw new Error("useTableEditorActivation must be used within TableEditorActivationProvider");
  }

  const requestActivation = useCallback(
    (): boolean => context.requestActivation(editorId),
    [context, editorId],
  );
  const releaseActivation = useCallback(
    (): void => context.releaseActivation(editorId),
    [context, editorId],
  );

  useEffect(() => releaseActivation, [releaseActivation]);

  return { requestActivation, releaseActivation };
};
