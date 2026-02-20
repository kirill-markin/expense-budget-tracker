export default function HomePage() {
  return (
    <main className="container">
      <div className="nav">
        <span className="badge">expense-budget-tracker</span>
        <a href="/dashboards/budget">Budget</a>
        <a href="/dashboards/budget-stream">Budget Stream</a>
        <a href="/dashboards/transactions">Transactions</a>
        <a href="/dashboards/balances">Balances</a>
      </div>

      <section className="panel">
        <h1 className="title">Expense Budget Tracker</h1>
        <ul className="link-list">
          <li><a href="/dashboards/budget">Budget</a></li>
          <li><a href="/dashboards/budget-stream">Budget Stream</a></li>
          <li><a href="/dashboards/transactions">Transactions</a></li>
          <li><a href="/dashboards/balances">Balances</a></li>
        </ul>
      </section>
    </main>
  );
}
