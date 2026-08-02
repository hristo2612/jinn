import { initDb } from '../sessions/registry.js';

/** True when the employee has spent at or above their calendar-month cap.
 *  This is the only budget question any caller asks — block the turn or not.
 *  An unset or non-positive cap means uncapped. */
export function isBudgetExhausted(employee: string, budgetConfig: Record<string, number> | undefined): boolean {
  const limit = budgetConfig?.[employee];
  if (!limit || limit <= 0) return false;

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const row = initDb().prepare(
    `SELECT COALESCE(SUM(total_cost), 0) as spend FROM sessions WHERE employee = ? AND created_at >= ?`
  ).get(employee, monthStart) as { spend: number };

  return row.spend >= limit;
}
