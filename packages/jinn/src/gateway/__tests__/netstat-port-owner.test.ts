import { describe, expect, it } from "vitest";
import { parseNetstatAddress, selectNetstatPortOwnerPid } from "../lifecycle.js";

/**
 * The Windows port lookup used to take the pid from the first `findstr LISTENING`
 * row and ignore the bind address entirely — the defect fixed for `lsof` but never
 * here — and that pid is handed to process.kill on the --take-port and force-kill
 * paths. These are pure functions over captured `netstat -ano` output, so they run
 * on Linux CI where the real command does not exist.
 */
const PORT = 7777;

/** Real `netstat -ano` shape: proto, local, foreign, state, pid. */
const TABLE = [
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:7777         0.0.0.0:0              LISTENING       4242",
  "  TCP    127.0.0.1:7777         127.0.0.1:51176        ESTABLISHED     4242",
  "  TCP    127.0.0.1:7777         127.0.0.1:60655        TIME_WAIT       0",
  "  TCP    127.0.0.1:9999         0.0.0.0:0              LISTENING       999",
  "  UDP    127.0.0.1:5353         *:*",
].join("\n");

describe("parseNetstatAddress", () => {
  it("splits IPv4 and bracketed IPv6 columns", () => {
    expect(parseNetstatAddress("127.0.0.1:7777")).toEqual({ host: "127.0.0.1", port: 7777 });
    expect(parseNetstatAddress("[::1]:7777")).toEqual({ host: "::1", port: 7777 });
    expect(parseNetstatAddress("0.0.0.0:0")).toEqual({ host: "0.0.0.0", port: 0 });
    expect(parseNetstatAddress("[::]:0")).toEqual({ host: "::", port: 0 });
  });

  it("rejects shapes it cannot read rather than guessing", () => {
    expect(parseNetstatAddress("*:*")).toBeUndefined();
    expect(parseNetstatAddress("nonsense")).toBeUndefined();
    expect(parseNetstatAddress("")).toBeUndefined();
  });
});

describe("selectNetstatPortOwnerPid", () => {
  it("picks the listener on the configured address, ignoring other rows", () => {
    // ESTABLISHED/TIME_WAIT share the port; only the wildcard-foreign row listens.
    // The pid-0 TIME_WAIT row must never be returned — it is killed downstream.
    expect(selectNetstatPortOwnerPid(TABLE, "127.0.0.1", PORT)).toEqual({ status: "found", pid: 4242 });
  });

  it("ignores a listener bound to a different interface", () => {
    // The original bug: a proxy on ::1 was reported as owning 127.0.0.1.
    const table = [
      "  TCP    [::1]:7777             [::]:0                 LISTENING       5555",
    ].join("\n");
    expect(selectNetstatPortOwnerPid(table, "127.0.0.1", PORT)).toEqual({ status: "none" });
  });

  it("still detects a wildcard listener that overlaps the configured address", () => {
    for (const wildcard of ["0.0.0.0:7777", "[::]:7777"]) {
      const table = `  TCP    ${wildcard}         0.0.0.0:0              LISTENING       6060`;
      expect(selectNetstatPortOwnerPid(table, "127.0.0.1", PORT)).toEqual({ status: "found", pid: 6060 });
    }
  });

  it("is independent of the state word, which netstat localises", () => {
    // German Windows prints ABHÖREN. Listening rows are identified by their
    // wildcard foreign address instead, so the locale cannot matter.
    const german = [
      "  Proto  Lokale Adresse         Remoteadresse          Status          PID",
      "  TCP    127.0.0.1:7777         0.0.0.0:0              ABHÖREN         7070",
    ].join("\n");
    expect(selectNetstatPortOwnerPid(german, "127.0.0.1", PORT)).toEqual({ status: "found", pid: 7070 });
  });

  it("reports unknown when it could not read a single row", () => {
    // A locale or SKU whose shape this cannot parse must NOT be reported as a free
    // port: that turns a clean refusal into an EADDRINUSE crash on the next start.
    expect(selectNetstatPortOwnerPid("Access is denied.", "127.0.0.1", PORT)).toEqual({ status: "unknown" });
    expect(selectNetstatPortOwnerPid("total nonsense here", "127.0.0.1", PORT)).toEqual({ status: "unknown" });
  });

  it("reports none when rows parsed but nothing owns the port", () => {
    // Distinct from the above: the table was understood and the port is genuinely
    // free, so a start may proceed.
    const table = "  TCP    127.0.0.1:9999         0.0.0.0:0              LISTENING       999";
    expect(selectNetstatPortOwnerPid(table, "127.0.0.1", PORT)).toEqual({ status: "none" });
  });

  it("skips 4-column UDP rows, which carry no state or pid", () => {
    const table = [
      "  UDP    127.0.0.1:7777         *:*",
      "  TCP    127.0.0.1:7777         0.0.0.0:0              LISTENING       8080",
    ].join("\n");
    expect(selectNetstatPortOwnerPid(table, "127.0.0.1", PORT)).toEqual({ status: "found", pid: 8080 });
  });

  it("treats a configured wildcard host as matching any listener", () => {
    const table = "  TCP    192.168.1.5:7777       0.0.0.0:0              LISTENING       9090";
    expect(selectNetstatPortOwnerPid(table, "0.0.0.0", PORT)).toEqual({ status: "found", pid: 9090 });
    // ...but a specific loopback host does not match that interface.
    expect(selectNetstatPortOwnerPid(table, "127.0.0.1", PORT)).toEqual({ status: "none" });
  });

  it("maps localhost to both loopback families", () => {
    for (const addr of ["127.0.0.1:7777", "[::1]:7777"]) {
      const table = `  TCP    ${addr}         0.0.0.0:0              LISTENING       1010`;
      expect(selectNetstatPortOwnerPid(table, "localhost", PORT)).toEqual({ status: "found", pid: 1010 });
    }
  });
});
