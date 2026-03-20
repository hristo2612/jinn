import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { ORG_DIR } from "../shared/paths.js";
import type { Employee, Department } from "../shared/types.js";
import { logger } from "../shared/logger.js";

export interface OrgScanResult {
  employees: Map<string, Employee>;
  departments: Map<string, Department>;
}

/**
 * Scan the org directory for employees and department hierarchy.
 * Returns the employee Map (backward-compatible) and also populates
 * orgPath / reportsTo on each employee from department.yaml files.
 */
export function scanOrg(): Map<string, Employee> {
  const { employees } = scanOrgFull();
  return employees;
}

/**
 * Full org scan returning both employees and departments.
 */
export function scanOrgFull(): OrgScanResult {
  const employees = new Map<string, Employee>();
  const departments = new Map<string, Department>();

  if (!fs.existsSync(ORG_DIR)) return { employees, departments };

  // ── Pass 1: Scan all employee YAML files ──────────────────────
  function scanEmployees(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanEmployees(fullPath);
      } else if (
        entry.name.endsWith(".yaml") &&
        entry.name !== "department.yaml"
      ) {
        try {
          const raw = fs.readFileSync(fullPath, "utf-8");
          const data = yaml.load(raw) as any;
          if (data && data.name && data.persona) {
            const relDir = path.relative(ORG_DIR, path.dirname(fullPath));
            const orgPath = relDir === "" ? undefined : relDir;
            const employee: Employee = {
              name: data.name,
              displayName: data.displayName || data.name,
              department:
                data.department || path.basename(path.dirname(fullPath)),
              rank: data.rank || "employee",
              engine: data.engine || "claude",
              model: data.model || "sonnet",
              persona: data.persona,
              emoji: typeof data.emoji === "string" ? data.emoji : undefined,
              cliFlags: Array.isArray(data.cliFlags) ? data.cliFlags : undefined,
              effortLevel: typeof data.effortLevel === "string" ? data.effortLevel : undefined,
              orgPath,
            };
            employees.set(employee.name, employee);
          }
        } catch (err) {
          logger.warn(`Failed to parse employee file ${fullPath}: ${err}`);
        }
      }
    }
  }

  scanEmployees(ORG_DIR);

  // ── Pass 2: Scan all department.yaml files ────────────────────
  function scanDepartments(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDepartments(fullPath);
      } else if (entry.name === "department.yaml") {
        try {
          const raw = fs.readFileSync(fullPath, "utf-8");
          const data = yaml.load(raw) as any;
          const deptDir = path.dirname(fullPath);
          const relPath = path.relative(ORG_DIR, deptDir);
          if (relPath === "") continue; // skip org root if there's a department.yaml there

          const parentRelPath = path.dirname(relPath);
          const parent = parentRelPath === "." ? undefined : parentRelPath;

          const dept: Department = {
            name: data?.name || path.basename(deptDir),
            displayName: data?.displayName || data?.name || path.basename(deptDir),
            description: data?.description,
            manager: data?.manager,
            path: relPath,
            parent,
            children: [],
            employees: [],
          };
          departments.set(relPath, dept);
        } catch (err) {
          logger.warn(`Failed to parse department file ${fullPath}: ${err}`);
        }
      }
    }
  }

  scanDepartments(ORG_DIR);

  // ── Pass 3: Build parent/children relationships ───────────────
  for (const [deptPath, dept] of departments) {
    if (dept.parent && departments.has(dept.parent)) {
      const parentDept = departments.get(dept.parent)!;
      if (!parentDept.children.includes(deptPath)) {
        parentDept.children.push(deptPath);
      }
    }
  }

  // ── Pass 4: Assign employees to departments and set reportsTo ─
  for (const [, employee] of employees) {
    const orgPath = employee.orgPath;
    if (orgPath && departments.has(orgPath)) {
      const dept = departments.get(orgPath)!;
      dept.employees.push(employee.name);

      // Set reportsTo from the department's manager field
      // (but not for the manager themselves — they report to parent dept manager)
      if (dept.manager && dept.manager !== employee.name) {
        employee.reportsTo = dept.manager;
      } else if (dept.manager === employee.name && dept.parent) {
        // Manager reports to parent department's manager
        const parentDept = departments.get(dept.parent);
        if (parentDept?.manager) {
          employee.reportsTo = parentDept.manager;
        }
      }
    }
  }

  return { employees, departments };
}

export function findEmployee(
  name: string,
  registry: Map<string, Employee>,
): Employee | undefined {
  return registry.get(name);
}

export function extractMention(
  text: string,
  registry: Map<string, Employee>,
): Employee | undefined {
  for (const [name, employee] of registry) {
    if (text.includes(`@${name}`)) {
      return employee;
    }
  }
  return undefined;
}

/**
 * Extract ALL mentioned employees from text (e.g. "@jinn-dev @jinn-qa do X").
 * Returns an array of matched employees (can be empty).
 */
export function extractMentions(
  text: string,
  registry: Map<string, Employee>,
): Employee[] {
  const mentioned: Employee[] = [];
  for (const [name, employee] of registry) {
    if (text.includes(`@${name}`)) {
      mentioned.push(employee);
    }
  }
  return mentioned;
}
