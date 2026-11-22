import { connection } from "next/server";

import {
  loadUsersList,
  USERS_LIST_ACTIVITY_WINDOW_DAYS,
  USERS_LIST_LIMIT,
  type ExcludedReason,
  type UsersListRow,
} from "@/server/reports/usersList";

import styles from "./users.module.css";

const EXCLUDED_REASON_LABELS: Readonly<Record<ExcludedReason, string>> = {
  local: "local dev user",
  admin_or_excluded: "admin or excluded",
};

const MISSING_DAY = "—";

const formatDay = (day: string | null): string => day ?? MISSING_DAY;

const formatPeopleCount = (count: number): string => `${count} ${count === 1 ? "person" : "people"}`;

const UserRow = (props: Readonly<{ user: UsersListRow }>) => {
  const { user } = props;
  return (
    <tr className={user.excludedReason === null ? undefined : styles.excluded} data-testid="users-row">
      <td>
        {user.email}
        {user.excludedReason !== null && (
          <span className={styles.reason}>{EXCLUDED_REASON_LABELS[user.excludedReason]}</span>
        )}
      </td>
      <td>{user.createdDay}</td>
      <td>{formatDay(user.firstOpenDay)}</td>
      <td>{formatDay(user.lastOpenDay)}</td>
      <td className={styles.number}>{user.openDaysInWindow}</td>
      <td className={styles.number}>{user.trackDaysInWindow}</td>
      <td>{user.surfaces.length === 0 ? MISSING_DAY : user.surfaces.join(", ")}</td>
    </tr>
  );
};

export default async function UsersPage() {
  await connection();
  const today = new Date().toISOString().slice(0, 10);
  const { totalCount, users } = await loadUsersList(today);

  return (
    <>
      <h1 className={styles.title}>Users</h1>
      <p className={styles.summary} data-testid="users-summary">
        {formatPeopleCount(totalCount)} (showing up to {USERS_LIST_LIMIT}). Days are UTC; window counts cover the
        last {USERS_LIST_ACTIVITY_WINDOW_DAYS} days ending {today}.
      </p>
      <div className={styles.tableWrapper}>
        <table className={styles.table} data-testid="users-table">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Signed up</th>
              <th scope="col">First open</th>
              <th scope="col">Last open</th>
              <th scope="col" className={styles.number}>Open days ({USERS_LIST_ACTIVITY_WINDOW_DAYS}d)</th>
              <th scope="col" className={styles.number}>Track days ({USERS_LIST_ACTIVITY_WINDOW_DAYS}d)</th>
              <th scope="col">Surfaces (all time)</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user: UsersListRow) => <UserRow key={user.userId} user={user} />)}
          </tbody>
        </table>
      </div>
    </>
  );
}
