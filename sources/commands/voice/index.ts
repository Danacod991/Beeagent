import type { Command } from "@/commands/types";
import { requireClientToken } from "@/client/clientApi";
import { startVoiceServer } from "@/commands/voice/server";
import { openBrowser } from "@/utils/browser";
import { randomBytes } from "node:crypto";

const USAGE = "bee voice [--thread <thread-id>] [--lang <tag>] [--port N] [--no-open]";

export type VoiceOptions = {
  port?: number;
  threadId: string | null;
  lang: string | null;
  open: boolean;
};

export const voiceCommand: Command = {
  name: "voice",
  description: "Talk with the Bee agent by voice in your browser (Bee test users only).",
  usage: USAGE,
  run: async (args, context) => {
    const options = parseVoiceArgs(args);
    // Fail here, with the standard message, instead of on the first spoken turn.
    await requireClientToken(context);

    const token = randomBytes(32).toString("hex");
    const { server, port } = startVoiceServer(context, {
      token,
      threadId: options.threadId,
      lang: options.lang,
      ...(options.port !== undefined ? { port: options.port } : {}),
    });
    // 127.0.0.1 is a secure context, which the microphone needs. The token is
    // in the fragment, so it never appears in a request line or a Referer.
    const url = `http://127.0.0.1:${port}/#token=${token}`;

    console.log("Bee voice agent is running. Open this link in Chrome, Edge or Safari:");
    console.log(`  ${url}`);
    console.log("The link works on this computer only. Press Ctrl+C to stop.");

    const stop = (): void => {
      server.stop(true);
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    if (options.open) {
      try {
        await openBrowser(url);
      } catch {
        // No browser launcher here; the printed link is enough.
      }
    }
  },
};

export function parseVoiceArgs(args: readonly string[]): VoiceOptions {
  const options: VoiceOptions = { threadId: null, lang: null, open: true };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--no-open") {
      options.open = false;
      continue;
    }
    if (arg === "--port" || arg === "--thread" || arg === "--lang") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      if (arg === "--port") {
        const port = Number(value);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new Error("--port must be an integer between 1 and 65535");
        }
        options.port = port;
      } else if (arg === "--thread") {
        if (value.length > 255) {
          throw new Error("--thread must be at most 255 characters");
        }
        options.threadId = value;
      } else {
        if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) {
          throw new Error("--lang must be a language tag such as en-US or de");
        }
        options.lang = value;
      }
      continue;
    }
    throw new Error(`Unexpected argument: ${String(arg)}`);
  }

  return options;
}
