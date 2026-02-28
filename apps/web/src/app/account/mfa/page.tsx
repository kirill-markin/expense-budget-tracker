import { MfaSetup } from "@/ui/MfaSetup";

export const dynamic = "force-dynamic";

export default function MfaPage() {
  const authEnabled = (process.env.AUTH_MODE ?? "none") === "proxy";

  return (
    <main className="container">
      <section className="panel">
        <h1 className="title">Two-Factor Authentication</h1>
        <MfaSetup authEnabled={authEnabled} />
      </section>
    </main>
  );
}
