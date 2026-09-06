import { vi } from "vitest";

// Requeue authority is under test; delivery transport belongs to the callback suite.
vi.mock("../../../sessions/callbacks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../sessions/callbacks.js")>()),
  recoverPendingSessionDeliveries: vi.fn(async () => 0),
}));
