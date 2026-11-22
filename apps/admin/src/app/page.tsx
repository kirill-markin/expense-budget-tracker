import { redirect } from "next/navigation";

export default function HomePage(): never {
  redirect("/analytics/level-1-metrics");
}
