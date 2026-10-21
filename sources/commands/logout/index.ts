import type { Command, CommandContext } from "@/commands/types";
import { clearPairingState, clearProxyConfig, clearToken } from "@/secureStore";

const USAGE = "bee logout";

export const logoutCommand: Command = {
  name: "logout",
  description: "Log out and clear stored credentials.",
  usage: USAGE,
  run: async (args, context) => {
    await handleLogout(args, context);
  },
};

async function handleLogout(
  args: readonly string[],
  context: CommandContext
): Promise<void> {
  if (args.length > 0) {
    throw new Error("logout does not accept arguments.");
  }
  await clearProxyConfig(context.env);
  await clearToken(context.env);
  // Also drop an unfinished `bee login`, so `bee status` cannot finish it later.
  await clearPairingState(context.env);
  console.log("Logged out.");
}
