import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathIsOwnerOnly } from "../shared/owner-only.js";

export const PAIRING_CHALLENGE_TTL_MS = 10_000;
export const PAIRING_CHALLENGE_FILE_PREFIX = "pair-challenge-";

export interface PairingChallenge {
  challengeId: string;
  nonce: string;
  path: string;
  expiresAt: number;
}

export interface PairingChallengeEntry {
  nonce: string;
  path: string;
  expiresAt: number;
}

export type PairingChallengeStore = Map<string, PairingChallengeEntry>;

const pairingChallenges: PairingChallengeStore = new Map();
const SAFE_CHALLENGE_ID = /^[A-Za-z0-9_-]{16,128}$/;

function randomChallengeValue(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function challengeFilePath(jinnHome: string, challengeId: string): string {
  return path.join(jinnHome, `${PAIRING_CHALLENGE_FILE_PREFIX}${challengeId}`);
}

function unlinkProof(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Validation is fail-closed. Cleanup failure must not turn an invalid proof
      // into a valid one; the challenge remains consumed either way.
    }
  }
}

/** The proof file must be reachable only by the operator running the gateway.
 *
 *  POSIX states that as mode 0o600 plus a uid matching both JINN_HOME and this
 *  process. Windows has neither concept — every uid is 0 and mode is synthetic —
 *  so the 0o600 test could never pass there and local pairing was impossible.
 *  Ask the ACL instead, which is what actually governs access on that platform.
 *  Both paths fail closed.
 *
 *  The checks are not symmetric: POSIX also pins the uid triple, while Windows
 *  verifies the DACL only, because `icacls /save` emits the DACL and not the
 *  owner. Planting a proof file still requires write access to a home that this
 *  same call asserts is owner-only, so the gap is not reachable on its own — but
 *  it is a gap, and an owner check belongs here if one becomes available. */
function proofOwnershipIsExclusive(jinnHome: string, file: string, proofStat: fs.Stats): boolean {
  if (process.platform === "win32") {
    return pathIsOwnerOnly(file) && pathIsOwnerOnly(jinnHome);
  }
  const homeStat = fs.statSync(jinnHome);
  if ((proofStat.mode & 0o777) !== 0o600) return false;
  if (proofStat.uid !== homeStat.uid) return false;
  if (typeof process.getuid === "function" && homeStat.uid !== process.getuid()) return false;
  return true;
}

function proofMatches(jinnHome: string, file: string, nonce: string): boolean {
  try {
    const proofStat = fs.lstatSync(file);
    if (!proofStat.isFile() || proofStat.isSymbolicLink()) return false;
    if (!proofOwnershipIsExclusive(jinnHome, file, proofStat)) return false;

    const expected = Buffer.from(nonce, "utf-8");
    if (proofStat.size !== expected.length) return false;
    const actual = fs.readFileSync(file);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function cleanupExpiredPairingChallenges(
  store: PairingChallengeStore = pairingChallenges,
  now = Date.now(),
): void {
  for (const [challengeId, entry] of store.entries()) {
    if (entry.expiresAt >= now) continue;
    store.delete(challengeId);
    unlinkProof(entry.path);
  }
}

export function issuePairingChallenge(
  jinnHome: string,
  store: PairingChallengeStore = pairingChallenges,
  now = Date.now(),
  challengeIdFactory: () => string = randomChallengeValue,
  nonceFactory: () => string = randomChallengeValue,
): PairingChallenge {
  cleanupExpiredPairingChallenges(store, now);
  const challengeId = challengeIdFactory();
  const nonce = nonceFactory();
  if (!SAFE_CHALLENGE_ID.test(challengeId) || nonce.length < 16) {
    throw new Error("Pairing challenge factories returned invalid values");
  }
  if (store.has(challengeId)) throw new Error("Pairing challenge id collision");

  const file = challengeFilePath(jinnHome, challengeId);
  const expiresAt = now + PAIRING_CHALLENGE_TTL_MS;
  store.set(challengeId, { nonce, path: file, expiresAt });
  return { challengeId, nonce, path: file, expiresAt };
}

export function consumePairingChallenge(
  jinnHome: string,
  challengeId: string | undefined | null,
  store: PairingChallengeStore = pairingChallenges,
  now = Date.now(),
): boolean {
  if (typeof challengeId !== "string" || !SAFE_CHALLENGE_ID.test(challengeId)) return false;
  const entry = store.get(challengeId);
  if (!entry) return false;

  // Every redemption attempt is terminal. This prevents correcting a mismatched
  // file after learning that the challenge id and route were accepted.
  store.delete(challengeId);
  try {
    if (entry.expiresAt < now) return false;
    if (path.resolve(entry.path) !== path.resolve(challengeFilePath(jinnHome, challengeId))) return false;
    return proofMatches(jinnHome, entry.path, entry.nonce);
  } finally {
    unlinkProof(entry.path);
  }
}
