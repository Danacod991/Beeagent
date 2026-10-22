import { describe, expect, it } from "bun:test";
import { parseManagedArgs } from "./command";

describe("managed sync arguments", () => {
  it("keeps legacy arguments on the legacy route", () => {
    expect(parseManagedArgs(["--full", "--only", "daily"])).toBeNull();
  });
  it("parses distinct managed actions and output independent of order", () => {
    expect(parseManagedArgs(["--managed"])).toEqual({ action: "sync", outputDir: "bee-sync" });
    expect(parseManagedArgs(["--output", "backup", "--reconcile"])).toEqual({ action: "preview", outputDir: "backup" });
    for (const action of ["apply", "restore"] as const) {
      expect(parseManagedArgs([`--${action}`, "12345678123412341234123456789abc", "--output", "backup"])).toEqual({ action, outputDir: "backup", planId: "12345678123412341234123456789abc" });
    }
  });
  it("rejects filters, conflicting actions, duplicate options and plan paths", () => {
    for (const args of [
      ["--managed", "--recent-days", "2"], ["--managed", "--only", "conversations"],
      ["--reconcile", "--full"], ["--reconcile", "--since", "1"],
      ["--managed", "--reconcile"], ["--managed", "--managed"],
      ["--apply"], ["--apply", "../../etc/passwd"], ["--restore", "not-a-plan"],
      ["--managed", "--output"], ["--managed", "--output", "--full"],
      ["--managed", "--output", "a", "--output", "b"], ["--managed", "positional"],
    ]) expect(() => parseManagedArgs(args)).toThrow();
  });
});
