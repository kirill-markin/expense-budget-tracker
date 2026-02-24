import { redirect } from "next/navigation";

export default function SiteHomePage() {
  const appDomain = process.env.APP_DOMAIN;
  if (appDomain !== undefined && appDomain !== "") {
    redirect(appDomain);
  }
  redirect("/");
}
