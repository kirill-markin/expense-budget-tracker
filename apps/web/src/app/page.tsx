export default function HomePage() {
  return (
    <main className="container">
      <section className="panel">
        <h1 className="title">Expense Budget Tracker</h1>
        <ul className="link-list">
          <li><a href="/dashboards/budget">Budget</a></li>
          <li><a href="/dashboards/budget-stream">Dashboard</a></li>
          <li><a href="/dashboards/transactions">Transactions</a></li>
          <li><a href="/dashboards/balances">Balances</a></li>
        </ul>
      </section>
    </main>
  );
}
