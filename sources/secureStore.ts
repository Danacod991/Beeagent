import type { Environment } from "@/environment";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_SERVICE = "bee-cli";

function readEnv(name: string): string | undefined {
  return process.env[name] ?? Bun.env[name];
}

// File-based fallback directory
const DEFAULT_CONFIG_DIR = join(homedir(), ".bee");
const getConfigDir = () => readEnv("BEE_CONFIG_DIR") ?? DEFAULT_CONFIG_DIR;
const getTokenFilePath = (env: Environment) => join(getConfigDir(), `token-${env}`);
const getPairingFilePath = (env: Environment) => join(getConfigDir(), `pairing-${env}.json`);
const getProxyConfigFilePath = (env: Environment) => join(getConfigDir(), `proxy-${env}.json`);

// Switches to file fallback when libsecret is unavailable
let useFileFallback = readEnv("BEE_FORCE_FILE_STORE") === "1";

function isFileFallbackEnabled(): boolean {
  return useFileFallback || readEnv("BEE_FORCE_FILE_STORE") === "1";
}

function tokenKey(env: Environment): { service: string; name: string } {
  return { service: TOKEN_SERVICE, name: `token:${env}` };
}

function pairingStateKey(env: Environment): { service: string; name: string } {
  return { service: TOKEN_SERVICE, name: `pairing:${env}` };
}

function handleKeychainError(err: unknown): void {
  const message = String(err).toLowerCase();
  const isKeychainUnavailable =
    message.includes("libsecret") ||
    message.includes("keychain") ||
    message.includes("secret service") ||
    message.includes("dbus");

  if (isKeychainUnavailable) {
    if (!useFileFallback) {
      useFileFallback = true;
      console.error("Keychain not available, using file-based token storage (~/.bee/)");
    }
  } else {
    throw err;
  }
}

function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { mode: 0o700, recursive: true });
  }
}

function loadTokenFromFile(env: Environment): string | null {
  const path = getTokenFilePath(env);
  if (!existsSync(path)) return null;
  try {
    const value = readFileSync(path, "utf-8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function saveTokenToFile(env: Environment, token: string): void {
  ensureConfigDir();
  writeFileSync(getTokenFilePath(env), token, { mode: 0o600 });
}

function clearTokenFromFile(env: Environment): void {
  const path = getTokenFilePath(env);
  if (existsSync(path)) unlinkSync(path);
}

export async function loadToken(env: Environment): Promise<string | null> {
  if (!isFileFallbackEnabled()) {
    try {
      const value = await Bun.secrets.get(tokenKey(env));
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
    } catch (err) {
      handleKeychainError(err);
    }
  }
  return loadTokenFromFile(env);
}

export async function saveToken(env: Environment, token: string): Promise<void> {
  if (!isFileFallbackEnabled()) {
    try {
      await Bun.secrets.set({ ...tokenKey(env), value: token });
      return;
    } catch (err) {
      handleKeychainError(err);
    }
  }
  saveTokenToFile(env, token);
}

export async function clearToken(env: Environment): Promise<void> {
  if (!isFileFallbackEnabled()) {
    try {
      await Bun.secrets.delete(tokenKey(env));
    } catch (err) {
      handleKeychainError(err);
    }
  }
  // Always clear file-based storage to remove any orphaned credentials
  clearTokenFromFile(env);
}

export type PairingState = {
  appId: string;
  publicKey: string;
  secretKey: string;
  requestId: string;
  pairingUrl: string;
  expiresAt: string;
};

const PAIRING_STATE_FIELDS: ReadonlyArray<keyof PairingState> = [
  "appId",
  "publicKey",
  "secretKey",
  "requestId",
  "pairingUrl",
  "expiresAt",
];

// A saved pairing request is usable only with every field present. Anything
// else, such as a truncated or hand-edited entry, counts as no saved request.
function toPairingState(value: unknown): PairingState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const fields = value as Record<string, unknown>;
  const complete = PAIRING_STATE_FIELDS.every((field) => typeof fields[field] === "string");
  return complete ? (value as PairingState) : null;
}

function loadPairingStateFromFile(env: Environment): PairingState | null {
  const path = getPairingFilePath(env);
  if (!existsSync(path)) return null;
  try {
    return toPairingState(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

function savePairingStateToFile(env: Environment, state: PairingState): void {
  ensureConfigDir();
  writeFileSync(getPairingFilePath(env), JSON.stringify(state), { mode: 0o600 });
}

function clearPairingStateFromFile(env: Environment): void {
  const path = getPairingFilePath(env);
  if (existsSync(path)) unlinkSync(path);
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function loadPairingState(env: Environment): Promise<PairingState | null> {
  if (!isFileFallbackEnabled()) {
    try {
      const value = await Bun.secrets.get(pairingStateKey(env));
      if (typeof value === "string" && value.trim().length > 0) {
        return toPairingState(parseJson<unknown>(value));
      }
    } catch (err) {
      handleKeychainError(err);
    }
  }
  return loadPairingStateFromFile(env);
}

export async function savePairingState(env: Environment, state: PairingState): Promise<void> {
  if (!isFileFallbackEnabled()) {
    try {
      await Bun.secrets.set({ ...pairingStateKey(env), value: JSON.stringify(state) });
      return;
    } catch (err) {
      handleKeychainError(err);
    }
  }
  savePairingStateToFile(env, state);
}

export async function clearPairingState(env: Environment): Promise<void> {
  if (!isFileFallbackEnabled()) {
    try {
      await Bun.secrets.delete(pairingStateKey(env));
    } catch (err) {
      handleKeychainError(err);
    }
  }
  // Always clear file-based storage to remove any orphaned credentials
  clearPairingStateFromFile(env);
}

export type ProxyConfig = {
  address: string;
};

function loadProxyConfigFromFile(env: Environment): ProxyConfig | null {
  const path = getProxyConfigFilePath(env);
  if (!existsSync(path)) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as
      | { address?: unknown }
      | null;
    if (!parsed || typeof parsed.address !== "string") {
      return null;
    }
    const address = parsed.address.trim();
    return address.length > 0 ? { address } : null;
  } catch {
    return null;
  }
}

function saveProxyConfigToFile(env: Environment, config: ProxyConfig): void {
  ensureConfigDir();
  writeFileSync(getProxyConfigFilePath(env), JSON.stringify(config), { mode: 0o600 });
}

function clearProxyConfigFromFile(env: Environment): void {
  const path = getProxyConfigFilePath(env);
  if (existsSync(path)) unlinkSync(path);
}

export async function loadProxyConfig(env: Environment): Promise<ProxyConfig | null> {
  return loadProxyConfigFromFile(env);
}

export async function saveProxyConfig(env: Environment, config: ProxyConfig): Promise<void> {
  const address = config.address.trim();
  if (!address) {
    throw new Error("Proxy address cannot be empty.");
  }
  saveProxyConfigToFile(env, { address });
}

export async function clearProxyConfig(env: Environment): Promise<void> {
  clearProxyConfigFromFile(env);
}
