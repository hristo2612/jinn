import fs from "node:fs";

/**
 * Remove a test's temporary directory, tolerating Windows' delayed handle release.
 *
 * POSIX unlinks a file that is still open; Windows refuses with EPERM until the
 * last handle closes, and a handle can outlive the code that owned it — a SQLite
 * connection closed microseconds earlier, or a child process the OS has not
 * finished reaping. A bare `rmSync` therefore throws out of `afterAll` and fails
 * the whole suite for a reason that has nothing to do with what it tested.
 *
 * `maxRetries`/`retryDelay` are Node's documented mitigation for exactly this:
 * EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM are retried with a linear backoff.
 * Half a second of patience is far cheaper than a flaky red leg.
 *
 * Closing whatever holds the handle first is still the right thing to do; this
 * covers what a test cannot close, not what it forgot to.
 */
export function removeTempDir(target: string): void {
  fs.rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 10 : 0,
    retryDelay: 50,
  });
}
