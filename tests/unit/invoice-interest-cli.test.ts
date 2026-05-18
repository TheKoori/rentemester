import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("invoice interest CLI", () => {
  test("posts a registered overdue late-interest claim to the ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-interest-post-cli-"));
    const company = join(root, "company");
    const paymentInput = join(root, "partial-payment.json");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    const issueProc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "issue", "--company", company, "--input", "examples/full-invoice.dk.json"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const issueStdout = await new Response(issueProc.stdout).text();
    const issueStderr = await new Response(issueProc.stderr).text();
    const issueExitCode = await issueProc.exited;
    expect({ issueExitCode, issueStderr }).toEqual({ issueExitCode: 0, issueStderr: "" });
    const issued = JSON.parse(issueStdout);

    writeFileSync(paymentInput, JSON.stringify({
      invoiceNumber: issued.invoiceNumber,
      paymentDate: "2026-05-20",
      amount: 1000,
      note: "Partial payment"
    }, null, 2));

    await Bun.$`bun run src/cli.ts invoice apply-payment --company ${company} --input ${paymentInput}`.quiet();
    await Bun.$`bun run src/cli.ts invoice claim-interest --company ${company} --invoice-number ${issued.invoiceNumber} --as-of 2026-06-20 --reference-rate 2.2`.quiet();

    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "post-interest", "--company", company, "--invoice-number", issued.invoiceNumber], {
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
    expect(parsed.entryId).toBeDefined();
    expect(parsed.accruedInterestAmount).toBe(0.35);
    expect(parsed.appliedRules).toContain("DK-INVOICE-LATE-INTEREST-BOOKKEEPING-001");
  });

  test("registers overdue late interest for an invoice", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-interest-register-cli-"));
    const company = join(root, "company");
    const paymentInput = join(root, "partial-payment.json");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    const issueProc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "issue", "--company", company, "--input", "examples/full-invoice.dk.json"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const issueStdout = await new Response(issueProc.stdout).text();
    const issueStderr = await new Response(issueProc.stderr).text();
    const issueExitCode = await issueProc.exited;
    expect({ issueExitCode, issueStderr }).toEqual({ issueExitCode: 0, issueStderr: "" });
    const issued = JSON.parse(issueStdout);

    writeFileSync(paymentInput, JSON.stringify({
      invoiceNumber: issued.invoiceNumber,
      paymentDate: "2026-05-20",
      amount: 1000,
      note: "Partial payment"
    }, null, 2));

    await Bun.$`bun run src/cli.ts invoice apply-payment --company ${company} --input ${paymentInput}`.quiet();

    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "claim-interest", "--company", company, "--invoice-number", issued.invoiceNumber, "--as-of", "2026-06-20", "--reference-rate", "2.2"], {
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
    expect(parsed.claimId).toBeDefined();
    expect(parsed.accruedInterestAmount).toBe(0.35);
    expect(parsed.appliedRules).toContain("DK-INVOICE-LATE-INTEREST-REGISTER-001");
  });

  test("calculates overdue late interest for an invoice", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-interest-cli-"));
    const company = join(root, "company");
    const paymentInput = join(root, "partial-payment.json");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    const issueProc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "issue", "--company", company, "--input", "examples/full-invoice.dk.json"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const issueStdout = await new Response(issueProc.stdout).text();
    const issueStderr = await new Response(issueProc.stderr).text();
    const issueExitCode = await issueProc.exited;
    expect({ issueExitCode, issueStderr }).toEqual({ issueExitCode: 0, issueStderr: "" });
    const issued = JSON.parse(issueStdout);

    writeFileSync(paymentInput, JSON.stringify({
      invoiceNumber: issued.invoiceNumber,
      paymentDate: "2026-05-20",
      amount: 1000,
      note: "Partial payment"
    }, null, 2));

    await Bun.$`bun run src/cli.ts invoice apply-payment --company ${company} --input ${paymentInput}`.quiet();

    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "interest", "--company", company, "--invoice-number", issued.invoiceNumber, "--as-of", "2026-06-20", "--reference-rate", "2.2"], {
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
    expect(parsed.annualInterestRatePercent).toBe(10.2);
    expect(parsed.accruedInterestAmount).toBe(0.35);
    expect(parsed.appliedRules).toContain("DK-INVOICE-LATE-INTEREST-001");
  });
});
