import { describe, expect, it, vi } from "vitest";

const { afterMock } = vi.hoisted(() => ({
  afterMock: vi.fn(() => {
    throw new Error("Nessun request scope nel test.");
  }),
}));

vi.mock("next/server", () => ({ after: afterMock }));

import { runAfterResponse, waitForAfterResponseTasks } from "@/lib/after-response";

describe("runAfterResponse", () => {
  it("espone una barriera che aspetta il completamento dei task fallback", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completed = false;

    runAfterResponse(async () => {
      await gate;
      completed = true;
    });

    let barrierCompleted = false;
    const barrier = waitForAfterResponseTasks().then(() => {
      barrierCompleted = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    expect(barrierCompleted).toBe(false);

    release();
    await barrier;

    expect(completed).toBe(true);
    expect(barrierCompleted).toBe(true);
  });
});
