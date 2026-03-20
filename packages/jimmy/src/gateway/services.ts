import type { Department, Employee } from "../shared/types.js";

/**
 * Find the lowest common ancestor of two department paths.
 * Returns the ancestor department path, or undefined if none found (they are both root-level).
 */
export function findCommonAncestor(
  deptA: string,
  deptB: string,
  departments: Map<string, Department>,
): string | undefined {
  // Build ancestor chain for A (including A itself)
  const ancestorsA = new Set<string>();
  let current: string | undefined = deptA;
  while (current) {
    ancestorsA.add(current);
    const dept = departments.get(current);
    current = dept?.parent;
  }

  // Walk B upward until we hit an ancestor of A
  current = deptB;
  while (current) {
    if (ancestorsA.has(current)) return current;
    const dept = departments.get(current);
    current = dept?.parent;
  }

  return undefined; // both are root-level, no common ancestor
}

/**
 * Build the route path from source department to target department.
 * Returns an array of department paths: [source, ..., common ancestor, ..., target]
 */
export function buildRoutePath(
  fromDept: string,
  toDept: string,
  departments: Map<string, Department>,
): string[] {
  if (fromDept === toDept) return [fromDept];

  const ancestor = findCommonAncestor(fromDept, toDept, departments);

  // Build upward path from source to ancestor
  const upPath: string[] = [];
  let current: string | undefined = fromDept;
  while (current && current !== ancestor) {
    upPath.push(current);
    const dept = departments.get(current);
    current = dept?.parent;
  }
  if (ancestor) upPath.push(ancestor);

  // Build downward path from ancestor to target
  const downPath: string[] = [];
  current = toDept;
  while (current && current !== ancestor) {
    downPath.unshift(current);
    const dept = departments.get(current);
    current = dept?.parent;
  }

  // Combine: up to ancestor (already includes ancestor) + down to target
  return [...upPath, ...downPath];
}

/**
 * Resolve the manager chain along a route path.
 * Returns an array of employees (managers) that the request passes through.
 */
export function resolveManagerChain(
  routePath: string[],
  departments: Map<string, Department>,
  employees: Map<string, Employee>,
): Employee[] {
  const chain: Employee[] = [];
  const seen = new Set<string>();

  for (const deptPath of routePath) {
    const dept = departments.get(deptPath);
    if (!dept?.manager) continue;
    if (seen.has(dept.manager)) continue;
    seen.add(dept.manager);
    const emp = employees.get(dept.manager);
    if (emp) chain.push(emp);
  }

  return chain;
}
