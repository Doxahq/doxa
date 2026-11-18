import { describe, expect, test, vi } from "vitest";
import { reportCronHeartbeat } from "../../src/services/cron-heartbeat";

const URL_ = "https://api.openstatus.dev/heartbeat/token";

describe("reportCronHeartbeat", () => {
  test("sends nothing without a URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(reportCronHeartbeat(undefined, [Promise.resolve()], fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("pings once after every job settles, with the count of failed jobs", async () => {
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    const pending = reportCronHeartbeat(
      URL_,
      [Promise.resolve(), Promise.reject(new Error("job failed")), slow],
      fetchImpl,
    );
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();

    finish();
    await expect(pending).resolves.toEqual({ jobs: 3, failed: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(URL_);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ jobs: 3, failed: 1 });
  });

  test("does not throw when the monitor cannot be reached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });

    await expect(reportCronHeartbeat(URL_, [], fetchImpl)).resolves.toEqual({ jobs: 0, failed: 0 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
