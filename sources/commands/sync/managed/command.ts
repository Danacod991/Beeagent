import type { CommandContext } from "@/commands/types";
import { fetchManagedSnapshot, type SnapshotFormatters } from "./snapshot";
import { assertManagedPlatform, withSyncOutputLock } from "./storage";

export type ManagedOptions = {
  outputDir: string;
  action: "sync" | "preview" | "apply" | "restore";
  planId?: string;
};

const ACTIONS = new Map<string, ManagedOptions["action"]>([
  ["--managed", "sync"], ["--reconcile", "preview"],
  ["--apply", "apply"], ["--restore", "restore"],
]);

/** Separate actions deliberately cannot inherit a filtered/incremental scan. */
export function parseManagedArgs(args: readonly string[]): ManagedOptions | null {
  if (!args.some((arg) => ACTIONS.has(arg))) return null;
  let outputDir = "bee-sync";
  let action: ManagedOptions["action"] | undefined;
  let planId: string | undefined;
  let hasOutput = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--output") {
      const value = args[++i];
      if (hasOutput || !value || value.startsWith("--")) {
        throw new Error("Provide --output exactly once with a directory.");
      }
      hasOutput = true;
      outputDir = value;
      continue;
    }
    const nextAction = ACTIONS.get(arg);
    if (!nextAction) {
      throw new Error("Managed sync accepts only one action and --output; filters and incremental options are not supported.");
    }
    if (action) throw new Error("Choose exactly one of --managed, --reconcile, --apply, or --restore.");
    action = nextAction;
    if (action === "apply" || action === "restore") {
      const value = args[++i];
      if (!value || !/^[a-f0-9]{32}$/.test(value)) {
        throw new Error("Provide the plan ID printed by --reconcile.");
      }
      planId = value;
    }
  }
  if (!action) throw new Error("A managed sync action is required.");
  return { outputDir, action, ...(planId !== undefined ? { planId } : {}) };
}

export async function runManagedSync(
  options: ManagedOptions,
  context: CommandContext,
  formatters: SnapshotFormatters,
): Promise<void> {
  assertManagedPlatform();
  await withSyncOutputLock(options.outputDir, async (locked) => {
    if (options.action === "restore") {
      const storage = await locked.localManaged(context.env);
      const result = await storage.restore(options.planId!);
      console.log(JSON.stringify({ action: "restore", ...result }, null, 2));
      console.error(`Restored ${result.restored} file(s); preserved ${result.conflicts.length} occupied destination(s).`);
      return;
    }
    console.error("Reading a complete Bee snapshot. Exported files will stay in place until the scan succeeds.");
    const snapshot = await fetchManagedSnapshot(context, formatters);
    const storage = await locked.managed(
      { accountHash: snapshot.account, env: context.env },
      { create: options.action === "sync" },
    );
    if (options.action === "sync") {
      const result = await storage.sync(snapshot.files);
      console.log(JSON.stringify({ action: "sync", ...result }, null, 2));
      console.error(`Wrote ${result.written} file(s), kept ${result.unchanged} unchanged, preserved ${result.conflicts.length} conflict(s).`);
      console.error("Missing exports are retained. Use --reconcile to review candidates for quarantine.");
    } else if (options.action === "preview") {
      const plan = await storage.preview(snapshot.files);
      console.log(JSON.stringify({ action: "preview", ...plan }, null, 2));
      console.error(`Preview: ${plan.candidates.length} candidate(s), ${plan.conflicts.length} preserved conflict(s).`);
      console.error("Candidates were absent from this scan; that does not prove server deletion. Review the paths before applying. Quarantine retains private data.");
      console.error(`After review: bee sync --apply ${plan.id} --output ${shellQuote(options.outputDir)}`);
    } else {
      const result = await storage.apply(options.planId!, snapshot.files);
      console.log(JSON.stringify({ action: "apply", ...result }, null, 2));
      console.error(`Quarantined ${result.quarantined} file(s)${result.alreadyApplied ? "; this plan was already applied" : ""}. This is not secure erasure.`);
      console.error(`Recover locally: bee sync --restore ${options.planId!} --output ${shellQuote(options.outputDir)}`);
    }
  });
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
