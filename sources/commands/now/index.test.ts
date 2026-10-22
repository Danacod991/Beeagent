import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { CommandContext } from "@/commands/types";
import { createProxyClient } from "@/client";
import { nowCommand } from "./index";

type BunServer = ReturnType<typeof Bun.serve>;

const activeServers: BunServer[] = [];
const HOUR_MS = 60 * 60 * 1000;

afterEach(() => {
  for (const server of activeServers.splice(0, activeServers.length)) {
    server.stop(true);
  }
});

function startApi(conversationStartTimes: number[]): CommandContext {
  const conversations = conversationStartTimes.map((startTime, index) => ({
    id: index + 1,
    start_time: startTime,
    created_at: startTime,
  }));
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      const match = path.match(/^\/v1\/conversations\/(\d+)$/);
      if (match) {
        const summary = conversations.find((c) => c.id === Number(match[1]));
        return Response.json({
          conversation: {
            ...summary,
            end_time: null,
            summary: null,
            short_summary: `Conversation ${match[1]}`,
            state: "COMPLETED",
            transcriptions: [],
          },
        });
      }
      return Response.json({ conversations, next_cursor: null, timezone: "UTC" });
    },
  });
  activeServers.push(upstream);
  return {
    env: "prod",
    client: createProxyClient("prod", { address: `http://127.0.0.1:${upstream.port}` }),
  };
}

async function runNow(args: string[], context: CommandContext): Promise<string> {
  const logs: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...items) => {
    logs.push(items.join(" "));
  });
  try {
    await nowCommand.run(args, context);
  } finally {
    logSpy.mockRestore();
  }
  return logs.join("\n");
}

describe("now command", () => {
  it("says which time window was empty", async () => {
    const output = await runNow([], startApi([]));
    expect(output).toContain("- (none in the last 10 hours)");
  });

  it("uses --hours to widen or narrow the window", async () => {
    const fiveHoursAgo = Date.now() - 5 * HOUR_MS;

    const narrow = await runNow(["--hours", "3"], startApi([fiveHoursAgo]));
    expect(narrow).toContain("- (none in the last 3 hours)");

    const wide = await runNow(["--hours", "6"], startApi([fiveHoursAgo]));
    expect(wide).toContain("## Conversation 1");

    const singular = await runNow(["--hours", "1"], startApi([]));
    expect(singular).toContain("- (none in the last 1 hour)");
  });

  it("accepts --hours together with --json", async () => {
    const context = startApi([]);
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...items) => {
      logs.push(items.join(" "));
    });
    const before = Date.now();
    try {
      await nowCommand.run(["--json", "--hours", "2"], context);
    } finally {
      logSpy.mockRestore();
    }
    const payload = JSON.parse(logs.join("\n")) as { since: number; until: number };
    expect(payload.until - payload.since).toBe(2 * HOUR_MS);
    expect(payload.until).toBeGreaterThanOrEqual(before);
  });

  it("rejects invalid --hours values and unknown arguments", async () => {
    const context = startApi([]);
    await expect(nowCommand.run(["--hours"], context)).rejects.toThrow("--hours requires a value");
    await expect(nowCommand.run(["--hours", "0"], context)).rejects.toThrow(
      "--hours must be an integer between 1 and 168"
    );
    await expect(nowCommand.run(["--hours", "200"], context)).rejects.toThrow(
      "--hours must be an integer between 1 and 168"
    );
    await expect(nowCommand.run(["--days", "2"], context)).rejects.toThrow(
      "Unexpected arguments: --days 2"
    );
  });
});
