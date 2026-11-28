"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ComponentProps, ReactElement } from "react";

import { withDemoLocaleHint } from "@/lib/localeHint";
import { useFilteredMode } from "@/ui/FilteredModeProvider";

type Props = Omit<ComponentProps<typeof Link>, "href"> & Readonly<{ href: string }>;

export const DemoLocaleLink = ({ href, ...props }: Props): ReactElement => {
  const { isDemoMode } = useFilteredMode();
  const searchParams = useSearchParams();
  return <Link {...props} href={withDemoLocaleHint(href, isDemoMode ? searchParams : null)} />;
};
