import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectPosixMode } from "../../shared/test-support/posix-mode.js";
import { enforceOwnerOnlyDirectory } from "../../shared/owner-only.js";
import {
  consumePairingChallenge,
  issuePairingChallenge,
  PAIRING_CHALLENGE_TTL_MS,
  type PairingChallengeStore,
} from "../pairing-challenge.js";

/** Resolve icacls from System32, never PATH. MSYS/Cygwin/Git Bash ship their own
 *  utilities ahead of Windows', and a bare name gets whichever comes first — the
 *  hazard `owner-only.ts` documents and this fixture must not reintroduce. */
function icacls(): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(root, "System32", "icacls.exe");
}

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pair-challenge-"));
  // The proof is only meaningful in a home nobody else can reach, and these
  // cases assume that premise. mkdtemp gives it for free on POSIX (0700), but
  // not on Windows, where a temp directory inherits whatever %TEMP% grants —
  // often several groups with Modify. Establish it explicitly so the fixture
  // matches the precondition on both platforms.
  enforceOwnerOnlyDirectory(home);
  return home;
}

function issue(home: string, store: PairingChallengeStore, now = 1_000) {
  return issuePairingChallenge(
    home,
    store,
    now,
    () => "challenge-id-1234567890",
    () => "nonce-value-1234567890",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pairing filesystem challenges", () => {
  it("accepts one exact owner-only proof file and deletes it before replay", () => {
    const home = tempHome();
    const store: PairingChallengeStore = new Map();
    const challenge = issue(home, store);
    fs.writeFileSync(challenge.path, challenge.nonce, { mode: 0o600 });
    fs.chmodSync(challenge.path, 0o600);

    expect(fs.statSync(challenge.path).uid).toBe(fs.statSync(home).uid);
    expectPosixMode(fs.statSync(challenge.path), 0o600);
    expect(consumePairingChallenge(home, challenge.challengeId, store, 1_001)).toBe(true);
    expect(fs.existsSync(challenge.path)).toBe(false);
    expect(consumePairingChallenge(home, challenge.challengeId, store, 1_002)).toBe(false);
  });

  it("rejects and deletes expired or mismatched proofs", () => {
    const home = tempHome();
    const store: PairingChallengeStore = new Map();
    const expired = issue(home, store);
    fs.writeFileSync(expired.path, expired.nonce, { mode: 0o600 });

    expect(consumePairingChallenge(home, expired.challengeId, store, 1_000 + PAIRING_CHALLENGE_TTL_MS + 1)).toBe(false);
    expect(fs.existsSync(expired.path)).toBe(false);

    const mismatch = issuePairingChallenge(
      home,
      store,
      20_000,
      () => "challenge-id-abcdefghij",
      () => "nonce-value-abcdefghij",
    );
    fs.writeFileSync(mismatch.path, "wrong-value-abcdefghij", { mode: 0o600 });

    expect(consumePairingChallenge(home, mismatch.challengeId, store, 20_001)).toBe(false);
    expect(fs.existsSync(mismatch.path)).toBe(false);
    expect(consumePairingChallenge(home, mismatch.challengeId, store, 20_002)).toBe(false);
  });

  it("rejects broad permissions, a foreign owner, and symlinks", () => {
    const home = tempHome();
    const store: PairingChallengeStore = new Map();
    const broad = issue(home, store);
    fs.writeFileSync(broad.path, broad.nonce, { mode: 0o644 });
    if (process.platform === "win32") {
      // chmod cannot widen anything on Windows. Grant the Everyone SID instead -
      // by SID, because the name is localized - which is what "readable by more
      // than the owner" actually means on this platform.
      execFileSync(icacls(), [broad.path, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
    } else {
      fs.chmodSync(broad.path, 0o644);
    }
    expect(consumePairingChallenge(home, broad.challengeId, store, 1_001)).toBe(false);

    // A forged uid is a POSIX-only notion: the Windows check reads the ACL, and
    // ownership cannot be reassigned to another account from inside a test.
    if (process.platform !== "win32") {
      const foreign = issuePairingChallenge(
        home,
        store,
        2_000,
        () => "challenge-id-foreign0001",
        () => "nonce-value-foreign0001",
      );
      fs.writeFileSync(foreign.path, foreign.nonce, { mode: 0o600 });
      const realLstat = fs.lstatSync.bind(fs);
      vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike) => {
        const stat = realLstat(file);
        if (path.resolve(String(file)) !== path.resolve(foreign.path)) return stat;
        const forged = Object.create(stat) as fs.Stats;
        Object.defineProperty(forged, "uid", { value: stat.uid + 1 });
        return forged;
      }) as typeof fs.lstatSync);
      expect(consumePairingChallenge(home, foreign.challengeId, store, 2_001)).toBe(false);
      vi.restoreAllMocks();
    }

    const symlink = issuePairingChallenge(
      home,
      store,
      3_000,
      () => "challenge-id-symlink0001",
      () => "nonce-value-symlink0001",
    );
    const target = path.join(home, "proof-target");
    fs.writeFileSync(target, symlink.nonce, { mode: 0o600 });
    fs.symlinkSync(target, symlink.path);
    expect(consumePairingChallenge(home, symlink.challengeId, store, 3_001)).toBe(false);
    expect(fs.existsSync(symlink.path)).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });
});
