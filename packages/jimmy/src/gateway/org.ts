import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { ORG_DIR } from "../shared/paths.js";
import type { Employee } from "../shared/types.js";
import { logger } from "../shared/logger.js";

export function scanOrg(): Map<string, Employee> {
  const registry = new Map<string, Employee>();

  if (!fs.existsSync(ORG_DIR)) return registry;

  // Recursively find all .yaml files in org/
  function scan(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (
        entry.name.endsWith(".yaml") &&
        entry.name !== "department.yaml"
      ) {
        try {
          const raw = fs.readFileSync(fullPath, "utf-8");
          const data = yaml.load(raw) as any;
          if (data && data.name && data.persona) {
            const employee: Employee = {
              name: data.name,
              displayName: data.displayName || data.name,
              department:
                data.department || path.basename(path.dirname(fullPath)),
              rank: data.rank || "employee",
              engine: data.engine || "claude",
              model: data.model || "sonnet",
              persona: data.persona,
            };
            registry.set(employee.name, employee);
          }
        } catch (err) {
          logger.warn(`Failed to parse employee file ${fullPath}: ${err}`);
        }
      }
    }
  }

  scan(ORG_DIR);
  return registry;
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
