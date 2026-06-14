import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactElement } from "react";

import { getLocaleCookie } from "@/lib/localeCookie";
import { t } from "@/i18n/serverT";
import {
  getPublicMonthlyCategoryShare,
  getPublicMonthlyCategoryShareMetadata,
} from "@/server/community/publicMonthlyCategoryShare";
import type { PublicMonthlyCategoryShare } from "@/server/community/publicMonthlyCategoryShareTypes";
import { PublicMonthlySharePage } from "@/ui/public-share/PublicMonthlySharePage";
import {
  buildLatestPublicMonthlyShareWindow,
  buildPublicMonthlyShareProbeWindow,
  PUBLIC_MONTHLY_SHARE_INITIAL_WINDOW_MONTHS,
  resolvePublicMonthlyShareLabel,
  type PublicMonthlyShareWindow,
} from "@/ui/public-share/publicMonthlyShareModel";

export const dynamic = "force-dynamic";

const SITE_HREF = "https://expense-budget-tracker.com/";

type PublicMonthlySharePageRouteProps = Readonly<{
  params: Promise<{
    token: string;
  }>;
}>;

type InitialPublicMonthlyShare = Readonly<{
  share: PublicMonthlyCategoryShare;
  jsonWindow: PublicMonthlyShareWindow;
}>;

const getPublicMonthlyShareForWindow = async (
  token: string,
  window: PublicMonthlyShareWindow,
): Promise<PublicMonthlyCategoryShare | null> =>
  getPublicMonthlyCategoryShare(token, window.monthFrom, window.monthTo);

const readInitialPublicMonthlyShare = async (
  token: string,
): Promise<InitialPublicMonthlyShare | null> => {
  const probeWindow = buildPublicMonthlyShareProbeWindow();
  const probeShare = await getPublicMonthlyShareForWindow(token, probeWindow);
  if (probeShare === null) {
    return null;
  }

  const latestWindow = buildLatestPublicMonthlyShareWindow(
    probeShare.availableMonthFrom,
    probeShare.availableMonthTo,
    PUBLIC_MONTHLY_SHARE_INITIAL_WINDOW_MONTHS,
  );
  if (latestWindow === null) {
    return {
      share: probeShare,
      jsonWindow: probeWindow,
    };
  }

  const latestShare = await getPublicMonthlyShareForWindow(token, latestWindow);
  if (latestShare === null) {
    return null;
  }

  return {
    share: latestShare,
    jsonWindow: latestWindow,
  };
};

const buildMetadataDescription = (
  title: string,
  currency: string,
  availableMonthFrom: string | null,
  availableMonthTo: string | null,
): string => {
  const range = availableMonthFrom === null || availableMonthTo === null
    ? null
    : `${availableMonthFrom} - ${availableMonthTo}`;
  return [title, currency, range].filter((value): value is string => value !== null).join(" - ");
};

export const generateMetadata = async (
  props: PublicMonthlySharePageRouteProps,
): Promise<Metadata> => {
  const locale = await getLocaleCookie();
  const { token } = await props.params;
  const fallbackTitle = t(locale, "publicShare.title");
  const probeWindow = buildPublicMonthlyShareProbeWindow();
  const [share, metadata] = await Promise.all([
    getPublicMonthlyShareForWindow(token, probeWindow),
    getPublicMonthlyCategoryShareMetadata(token),
  ]);

  if (share === null) {
    return {
      title: fallbackTitle,
      description: t(locale, "publicShare.notFound"),
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  const label = resolvePublicMonthlyShareLabel(share.label, t(locale, "publicShare.anonymousUser"));
  const title = `${label} | ${fallbackTitle}`;
  const allowIndexing = metadata?.indexingEnabled === true;

  return {
    title,
    description: buildMetadataDescription(
      fallbackTitle,
      share.currency,
      share.availableMonthFrom,
      share.availableMonthTo,
    ),
    robots: {
      index: allowIndexing,
      follow: allowIndexing,
    },
  };
};

export default async function Page(
  props: PublicMonthlySharePageRouteProps,
): Promise<ReactElement> {
  const locale = await getLocaleCookie();
  const { token } = await props.params;
  const initial = await readInitialPublicMonthlyShare(token);
  if (initial === null) {
    notFound();
  }

  return (
    <PublicMonthlySharePage
      token={token}
      initialShare={initial.share}
      initialJsonWindow={initial.jsonWindow}
      locale={locale}
      siteHref={SITE_HREF}
    />
  );
}
