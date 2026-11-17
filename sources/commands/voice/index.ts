import type { Command } from "@/commands/types";
import { requireClientToken } from "@/client/clientApi";
import { startVoiceServer, type VoiceServerOptions } from "@/commands/voice/server";
import { openBrowser } from "@/utils/browser";
import { renderQrCode } from "@/utils/qrCode";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";

const USAGE = [
  "bee voice [--thread <thread-id>] [--lang <tag>] [--port N] [--no-open]",
  "bee voice --host <address> [--password <value>] [--tls-cert <path> --tls-key <path>]",
  "  (password may also be set via BEE_VOICE_PASSWORD; at least 8 characters)",
].join("\n");

// Short enough to type on a phone, long enough that 10 guesses per 10 minutes
// get nowhere.
const GENERATED_PASSWORD_BYTES = 6;
const MIN_PASSWORD_LENGTH = 8;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type VoiceOptions = {
  port?: number;
  threadId: string | null;
  lang: string | null;
  open: boolean;
  host: string | null;
  password: string | null;
  tlsCert: string | null;
  tlsKey: string | null;
};

export const voiceCommand: Command = {
  name: "voice",
  description: "Talk with the Bee agent by voice in your browser (Bee test users only).",
  usage: USAGE,
  run: async (args, context) => {
    const options = parseVoiceArgs(args, process.env["BEE_VOICE_PASSWORD"]);
    // Fail here, with the standard message, instead of on the first spoken turn.
    await requireClientToken(context);

    const shared = options.host !== null && !LOOPBACK_HOSTS.has(options.host);
    // Reachable from other devices without a password would hand anyone on the
    // network this account's Bee data, so one is always required there.
    const password = options.password ?? (shared ? generatePassword() : null);
    const token = randomBytes(32).toString("hex");

    const serverOptions: VoiceServerOptions = {
      token,
      threadId: options.threadId,
      lang: options.lang,
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.host !== null ? { host: options.host } : {}),
      ...(password !== null ? { password } : {}),
      ...(options.tlsCert !== null && options.tlsKey !== null
        ? { tls: { certPath: options.tlsCert, keyPath: options.tlsKey } }
        : {}),
    };
    const { server, port } = startVoiceServer(context, serverOptions);

    const scheme = options.tlsCert !== null ? "https" : "http";
    const linkHost = displayHost(options.host);
    // With a password the page asks for it, so the token stays out of the link.
    // Otherwise it rides in the fragment, which browsers never send to a server.
    const url = password === null
      ? `${scheme}://${linkHost}:${port}/#token=${token}`
      : `${scheme}://${linkHost}:${port}/`;

    console.log("Bee voice agent is running.");
    console.log(`  ${url}`);
    if (password !== null) {
      console.log(`  Password: ${password}`);
      try {
        console.log(await renderQrCode(url));
      } catch {
        // A terminal that cannot draw the QR code still has the link.
      }
    }
    for (const line of advice(shared, scheme, options)) {
      console.log(line);
    }
    console.log("Press Ctrl+C to stop.");

    const stop = (): void => {
      server.stop(true);
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    if (options.open && !shared) {
      try {
        await openBrowser(url);
      } catch {
        // No browser launcher here; the printed link is enough.
      }
    }
  },
};

function advice(shared: boolean, scheme: string, options: VoiceOptions): string[] {
  const lines: string[] = [];
  if (!shared && options.password === null) {
    lines.push("The link works on this computer only.");
    return lines;
  }
  if (shared) {
    lines.push("Anyone who reaches this address and knows the password can read your Bee data.");
  } else {
    lines.push(
      "Listening on this computer only; point a tunnel or reverse proxy " +
      "(cloudflared, tailscale serve, ngrok) at it to reach it from elsewhere."
    );
  }
  if (scheme === "http" && shared) {
    // getUserMedia needs a secure context, which plain http is only on loopback.
    lines.push(
      "Browsers only allow the microphone over https, so voice input will not " +
      "work at this address. Serve it with --tls-cert/--tls-key, or through a " +
      "tunnel that terminates https. Typing works either way."
    );
  }
  return lines;
}

function generatePassword(): string {
  // base64url of 6 bytes: 8 characters, no look-alike-free alphabet needed
  // because it is shown next to a QR code rather than dictated.
  return randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url");
}

// The address to print. 0.0.0.0 and :: mean "every interface", so show the LAN
// address of this machine instead, which is the one another device can open.
function displayHost(host: string | null): string {
  if (host === null) {
    return "127.0.0.1";
  }
  if (host !== "0.0.0.0" && host !== "::" && host !== "[::]") {
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  }
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return "127.0.0.1";
}

export function parseVoiceArgs(args: readonly string[], envPassword?: string | undefined): VoiceOptions {
  const options: VoiceOptions = {
    threadId: null,
    lang: null,
    open: true,
    host: null,
    password: null,
    tlsCert: null,
    tlsKey: null,
  };

  const VALUE_FLAGS = new Set(["--port", "--thread", "--lang", "--host", "--password", "--tls-cert", "--tls-key"]);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--no-open") {
      options.open = false;
      continue;
    }
    if (arg === undefined || !VALUE_FLAGS.has(arg)) {
      throw new Error(`Unexpected argument: ${String(arg)}`);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    i += 1;
    switch (arg) {
      case "--port": {
        const port = Number(value);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new Error("--port must be an integer between 1 and 65535");
        }
        options.port = port;
        break;
      }
      case "--thread":
        if (value.length > 255) {
          throw new Error("--thread must be at most 255 characters");
        }
        options.threadId = value;
        break;
      case "--lang":
        if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) {
          throw new Error("--lang must be a language tag such as en-US or de");
        }
        options.lang = value;
        break;
      case "--host":
        options.host = value;
        break;
      case "--password":
        options.password = value;
        break;
      case "--tls-cert":
        options.tlsCert = value;
        break;
      default:
        options.tlsKey = value;
        break;
    }
  }

  if (options.password === null && envPassword !== undefined && envPassword !== "") {
    options.password = envPassword;
  }
  if (options.password !== null && options.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if ((options.tlsCert === null) !== (options.tlsKey === null)) {
    throw new Error("--tls-cert and --tls-key must be given together");
  }
  for (const path of [options.tlsCert, options.tlsKey]) {
    if (path !== null && !existsSync(path)) {
      throw new Error(`No such file: ${path}`);
    }
  }

  return options;
}
