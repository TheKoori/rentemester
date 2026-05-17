import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("vat report CLI", () => {
  test("returns a VAT report for a company period", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-vatcli-"));
    const company = join(root, "company");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    await Bun.$`bun run src/cli.ts documents ingest --company ${company} --file examples/vendor-invoice.txt --metadata examples/vendor-invoice.metadata.json`.quiet();
    await Bun.$`bun run src/cli.ts journal post --company ${company} --input examples/journal-entry.expense.json`.quiet();

    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "vat", "report", "--company", company, "--from", "2026-05-01", "--to", "2026-05-31"], {
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
    expect(parsed.inputVat).toBe(250);
    expect(parsed.netVatPayable).toBe(-250);
    expect(parsed.taxAgencyMapping).toEqual({
      rubrikA_outputVatDomestic: 0,
      rubrikB_euGoodsPurchaseVat: 0,
      rubrikC_euServicesPurchaseVat: 0,
      rubrikD_inputVatDomestic: 250,
      rubrikE_euGoodsSale: 0,
      rubrikF_euServicesSale: 0,
      rubrikG_exportOutsideEu: 0,
      netToPayOrReceive: -250,
    });
    expect(parsed.formGuidance).toEqual({
      skatTastSelvUrl: "https://www.skat.dk/tastselv/erhverv",
      periodLabel: "2026-05-01..2026-05-31",
      companyCvr: "DK12345678",
    });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.journalEntryCount).toBe(1);
    expect(parsed.totalJournalEntryCount).toBe(1);
  });
});
