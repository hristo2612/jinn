import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

/** Wildcard TLD patterns — *.com matches anything ending in .com */
const TLDS = [
  "com", "org", "net", "io", "dev", "co", "ai", "app", "me", "us",
  "uk", "de", "fr", "es", "it", "nl", "se", "no", "dk", "fi",
  "jp", "kr", "cn", "in", "au", "nz", "ca", "br", "mx", "ar",
  "ru", "pl", "cz", "at", "ch", "be", "pt", "ie", "bg",
  "edu", "gov", "mil", "info", "biz", "pro", "xyz", "site",
  "online", "tech", "store", "cloud", "design", "world", "today",
  "life", "space", "fun", "club", "page", "so", "is", "im", "la",
  "tv", "fm", "am", "ly", "to", "cc", "gg", "sh", "gl", "tf",
  "ws", "cx", "sx", "ag", "vc", "mobi", "tel", "coop", "aero",
  "jobs", "eu", "asia", "africa", "run", "tools", "systems",
  "software", "solutions", "services", "network", "digital",
  "agency", "studio", "media", "group", "team", "work", "zone",
  "live", "rocks", "ninja", "guru", "land", "house", "center",
  "academy", "link", "click", "help", "how", "watch", "review",
  "guide", "news", "blog", "wiki", "email", "chat", "social",
  "video", "photo", "music", "game", "games", "travel", "health",
  "bio", "eco", "green", "shop", "boutique", "fashion", "style",
  "art", "gallery", "photography", "builders", "construction",
  "energy", "technology", "computer", "mobile", "hosting",
  "domains", "website", "web", "codes", "engineering", "science",
  "legal", "law", "consulting", "training", "education", "school",
  "realty", "estate", "properties", "delivery", "express", "direct",
  "supply", "parts", "tools", "repair", "support", "care",
  "recipes", "restaurant", "bar", "cafe", "pub", "pizza", "coffee",
  "deals", "cheap", "discount", "sale", "rent", "loan", "credit",
  "insurance", "finance", "capital", "fund", "exchange", "market",
  "co.uk", "co.jp", "co.kr", "co.in", "co.nz", "co.za",
  "com.au", "com.br", "com.mx", "com.ar", "com.cn", "com.tw",
  "org.uk", "net.au", "ac.uk",
];

function getChromeExtensionDbPath(): string | null {
  const home = os.homedir();
  const platform = os.platform();

  const candidates: string[] = [];

  if (platform === "darwin") {
    candidates.push(
      path.join(home, "Library", "Application Support", "Google", "Chrome", "Default", "Local Extension Settings", EXTENSION_ID),
      path.join(home, "Library", "Application Support", "Google", "Chrome", "Profile 1", "Local Extension Settings", EXTENSION_ID),
    );
  } else if (platform === "linux") {
    candidates.push(
      path.join(home, ".config", "google-chrome", "Default", "Local Extension Settings", EXTENSION_ID),
      path.join(home, ".config", "google-chrome", "Profile 1", "Local Extension Settings", EXTENSION_ID),
    );
  } else if (platform === "win32") {
    const appData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    candidates.push(
      path.join(appData, "Google", "Chrome", "User Data", "Default", "Local Extension Settings", EXTENSION_ID),
      path.join(appData, "Google", "Chrome", "User Data", "Profile 1", "Local Extension Settings", EXTENSION_ID),
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isChromeRunning(): boolean {
  try {
    const platform = os.platform();
    if (platform === "darwin") {
      execSync("pgrep -x 'Google Chrome'", { stdio: "ignore" });
    } else if (platform === "linux") {
      execSync("pgrep -x chrome", { stdio: "ignore" });
    } else if (platform === "win32") {
      execSync("tasklist /FI \"IMAGENAME eq chrome.exe\" | findstr chrome.exe", { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

function quitChrome(): boolean {
  try {
    const platform = os.platform();
    if (platform === "darwin") {
      execSync("osascript -e 'tell application \"Google Chrome\" to quit'", { stdio: "ignore", timeout: 10000 });
    } else if (platform === "linux") {
      execSync("pkill -TERM chrome", { stdio: "ignore" });
    } else if (platform === "win32") {
      execSync("taskkill /IM chrome.exe", { stdio: "ignore" });
    }
    // Wait for Chrome to fully close
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (!isChromeRunning()) return true;
      execSync("sleep 0.5");
    }
    return !isChromeRunning();
  } catch {
    return false;
  }
}

function openChrome(): void {
  try {
    const platform = os.platform();
    if (platform === "darwin") {
      execSync("open -a 'Google Chrome'", { stdio: "ignore" });
    } else if (platform === "linux") {
      execSync("google-chrome &", { stdio: "ignore" });
    } else if (platform === "win32") {
      execSync("start chrome", { stdio: "ignore" });
    }
  } catch {
    // User can open Chrome manually
  }
}

export async function runChromeAllow(opts: { restart?: boolean }): Promise<void> {
  // 1. Check for classic-level
  let ClassicLevel: any;
  try {
    const mod = await import("classic-level");
    ClassicLevel = mod.ClassicLevel;
  } catch {
    console.error(`${RED}Error:${RESET} classic-level is required but not installed.`);
    console.error(`Run: ${DIM}npm install -g classic-level${RESET} or ${DIM}pnpm add classic-level${RESET}`);
    process.exit(1);
  }

  // 2. Find the extension DB
  const dbPath = getChromeExtensionDbPath();
  if (!dbPath) {
    console.error(`${RED}Error:${RESET} Claude Chrome extension not found.`);
    console.error("Install it from the Chrome Web Store first.");
    process.exit(1);
  }

  // 3. Chrome must be closed to write to LevelDB
  const chromeWasRunning = isChromeRunning();
  if (chromeWasRunning) {
    if (opts.restart === false) {
      console.error(`${RED}Error:${RESET} Chrome is running. Close it first or use ${DIM}--restart${RESET} to auto-restart.`);
      process.exit(1);
    }
    console.log(`${YELLOW}Closing Chrome...${RESET}`);
    const closed = quitChrome();
    if (!closed) {
      console.error(`${RED}Error:${RESET} Failed to close Chrome. Please close it manually and try again.`);
      process.exit(1);
    }
    console.log(`${GREEN}Chrome closed.${RESET}`);
  }

  // 4. Open LevelDB and write permissions
  const db = new ClassicLevel(dbPath, { keyEncoding: "utf8", valueEncoding: "utf8" });

  let data: { permissions: any[] };
  try {
    const raw = await db.get("permissionStorage");
    data = JSON.parse(raw);
  } catch {
    data = { permissions: [] };
  }

  const existingNetlocs = new Set(
    data.permissions
      .filter((p: any) => p.scope?.type === "netloc")
      .map((p: any) => p.scope.netloc),
  );

  const now = Date.now();
  let added = 0;
  for (const tld of TLDS) {
    const netloc = `*.${tld}`;
    if (!existingNetlocs.has(netloc)) {
      data.permissions.push({
        action: "allow",
        createdAt: now,
        duration: "always",
        id: randomUUID(),
        scope: { netloc, type: "netloc" },
      });
      added++;
    }
  }

  if (added === 0) {
    console.log(`${GREEN}All ${TLDS.length} TLD wildcards already present.${RESET} Nothing to do.`);
  } else {
    await db.put("permissionStorage", JSON.stringify(data));
    console.log(`${GREEN}✓${RESET} Added ${added} wildcard permissions (${TLDS.length} TLDs covered)`);
  }

  await db.close();

  // 5. Restart Chrome if it was running
  if (chromeWasRunning && opts.restart !== false) {
    console.log(`${DIM}Reopening Chrome...${RESET}`);
    openChrome();
    console.log(`${GREEN}✓${RESET} Chrome restarted. All sites are now pre-approved for the Claude extension.`);
  } else {
    console.log(`${GREEN}✓${RESET} Done. All sites will be pre-approved when Chrome starts.`);
  }
}
