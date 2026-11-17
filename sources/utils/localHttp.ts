// Guards shared by the CLI's localhost-only HTTP servers.
import { timingSafeEqual } from "node:crypto";

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function isAllowedHost(host: string | null): boolean {
  if (host === null) {
    return false;
  }
  const withoutPort = stripPort(host);
  return ALLOWED_HOSTS.has(withoutPort.toLowerCase());
}

function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

// True when the Host header, and the Origin header if present, both name this
// machine. Blocks DNS rebinding and requests made by other websites.
export function isLocalRequest(request: Request): boolean {
  if (!isAllowedHost(request.headers.get("host"))) {
    return false;
  }

  const origin = request.headers.get("origin");
  if (origin === null) {
    return true;
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return isAllowedHost(originHost);
}

export function isBearerAuthorized(request: Request, token: string): boolean {
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const [scheme, ...parts] = authHeader.split(" ");
    const bearer = parts.join(" ").trim();
    if (scheme?.toLowerCase() === "bearer" && secureEqual(bearer, token)) {
      return true;
    }
  }

  return false;
}

export function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function isAddressInUseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("eaddrinuse") ||
    (message.includes("failed to start server") &&
      message.includes("port") &&
      message.includes("use"));
}
