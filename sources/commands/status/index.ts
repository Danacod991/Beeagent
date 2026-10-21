import type { Command, CommandContext } from "@/commands/types";
import { getEnvironmentConfig } from "@/environment";
import { loadToken } from "@/secureStore";
import { fetchClientMe, type ClientUser } from "@/client/clientMe";
import {
  describePairingExpiry,
  finishPendingLogin,
  type PendingLogin,
} from "@/commands/login";

const USAGE = "bee status";

export const statusCommand: Command = {
  name: "status",
  description: "Show current authentication status.",
  usage: USAGE,
  run: async (args, context) => {
    await handleStatus(args, context);
  },
};

async function handleStatus(
  args: readonly string[],
  context: CommandContext
): Promise<void> {
  if (args.length > 0) {
    throw new Error("status does not accept arguments.");
  }

  const config = getEnvironmentConfig(context.env);
  const proxyAddress = context.client.isProxy ? context.client.proxyAddress : undefined;

  console.log(`API: ${config.label} (${config.apiUrl})`);

  if (proxyAddress) {
    console.log(`Connected via proxy: ${proxyAddress}`);
    const user = await fetchClientMe(context);
    printVerifiedUser(user);
    return;
  }

  const token = await loadToken(context.env);
  if (!token) {
    await reportPendingLogin(context);
    return;
  }

  console.log(`Token: ${maskToken(token)}`);

  const user = await fetchClientMe(context, token);
  printVerifiedUser(user);
}

// With no stored token, an unfinished `bee login` (for example one run with
// --no-wait) may be waiting for approval. Check it once, without waiting, and
// finish the login if it has been approved. A failed check is reported but
// does not fail the command, since the CLI is still not logged in.
async function reportPendingLogin(context: CommandContext): Promise<void> {
  let pending: PendingLogin;
  try {
    pending = await finishPendingLogin(context);
  } catch (error) {
    console.log("Not logged in.");
    console.log(
      `Could not finish the pending login: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  if (pending.status === "completed") {
    console.log("Pending login approved. Logged in.");
    console.log(`Token: ${maskToken(pending.token)}`);
    printVerifiedUser(pending.user);
    return;
  }

  console.log("Not logged in.");

  if (pending.status === "pending") {
    console.log("Login pending approval.");
    console.log(`Authentication link: ${pending.pairingUrl}`);
    console.log(describePairingExpiry(pending.expiresAt));
    console.log(
      "After approving, run 'bee status' again to finish, or run 'bee login' to wait for approval."
    );
  } else if (pending.status === "expired") {
    console.log("The pending login expired. Run 'bee login' to start a new one.");
  }
}

function printVerifiedUser(user: ClientUser): void {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  console.log(`Verified as ${name} (id ${user.id}).`);
}

function maskToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 8) {
    return "********";
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
