import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("invoice recover-bad-debt-bank CLI", () => {
  test("recovers a written-off invoice from bank via CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bad-debt-recovery-cli-"));
    const company = join(root, "company");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    await Bun.$`bun run src/cli.ts invoice issue --company ${company} --input examples/full-invoice.dk.json`.quiet();
    await Bun.$`bun run src/cli.ts invoice post --company ${company} --document-id 1`.quiet();
    await Bun.$`bun run src/cli.ts invoice write-off-bad-debt --company ${company} --input examples/invoice-bad-debt-writeoff.json`.quiet();
    await Bun.$`bun run src/cli.ts bank import --company ${company} --file examples/customer-bad-debt-recovery.csv`.quiet();

    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "recover-bad-debt-bank", "--company", company, "--input", "examples/invoice-bad-debt-recovery.json"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    rmSync(root, { recursive: true, force: true });
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.appliedRules).toContain("DK-INVOICE-BAD-DEBT-RECOVERY-001");
    expect(parsed.appliedRules).toContain("DK-VAT-BAD-DEBT-RECOVERY-001");
    expect(parsed.grossAmount).toBe(500);
    expect(parsed.remainingBadDebtExposure).toBe(750);
  });
});
