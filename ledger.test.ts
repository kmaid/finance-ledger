// Builds a ledger from the made-up data in examples/ and checks the figures.

import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { build, parseCsv, parseTsv, pence } from "./ledger.ts";

let data: string;
let db: DatabaseSync | undefined;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "ledger-"));
  cpSync(join(import.meta.dirname, "examples"), data, { recursive: true });
});

afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(data, { recursive: true });
});

const rows = (sql: string) => db!.prepare(sql).all().map((row) => Object.values(row));

test("pence reads amounts exactly", () => {
  assert.equal(pence("4,417.45"), 441745);
  assert.equal(pence("0.07"), 7);
  assert.equal(pence("19.9"), 1990);
  assert.equal(pence("-12"), -1200);
  assert.equal(pence(""), 0);
  assert.throws(() => pence("12.345"));
});

test("parseCsv handles quotes, commas and newlines inside fields", () => {
  assert.deepEqual(parseCsv('a,"b, ""c""",d\r\n"line\nbreak",,\n'), [
    ["a", 'b, "c"', "d"],
    ["line\nbreak", "", ""],
  ]);
});

test("parseTsv splits on tabs and leaves quotes alone", () => {
  assert.deepEqual(parseTsv('a\t"b"\t\r\n\r\nc\td, e\t1\n'), [
    ["a", '"b"', ""],
    ["c", "d, e", "1"],
  ]);
});

test("a transaction in two exports is stored once with its newest status", () => {
  db = build(data);
  assert.deepEqual(rows("SELECT COUNT(*) FROM transactions WHERE account = 'tide'"), [[8]]);
  assert.deepEqual(rows("SELECT status FROM transactions WHERE bank_id = '1002'"), [["cleared"]]);
});

test("business yearly figures", () => {
  db = build(data);
  // Paid to self is 2,000 plus the 5,000 left of the 25,000 lump sum after the ISA override.
  assert.deepEqual(rows("SELECT * FROM business_yearly"), [
    ["2018", 1500, 125, 0, 0, 0],
    ["2025", 7000, 583.33, 1234.56, 5000, 20000],
  ]);
});

test("cancelled transactions are left out and unmatched ones are reported", () => {
  db = build(data);
  assert.deepEqual(rows("SELECT COUNT(*) FROM ledger WHERE payee LIKE 'Hosting%'"), [[0]]);
  assert.deepEqual(rows("SELECT payee, total FROM uncategorised WHERE tag = 'business'"), [["Corner Cafe - 1 High Street, London", -8.5]]);
});

test("the ledger adds up to the cleared transactions", () => {
  db = build(data);
  const expected = 1200000 - 200000 - 123456 - 2500000 - 240000 - 500000 - 850;
  assert.deepEqual(rows("SELECT SUM(amount_pence) FROM ledger WHERE account = 'tide'"), [[expected]]);
});

test("overrides larger than the transaction are refused", () => {
  appendFileSync(join(data, "overrides.csv"), "tide,1004,Tax,6000,too much\n");
  assert.throws(() => build(data), /add up to more than the transaction for 1004/);
});

test("an export with unknown columns is refused", () => {
  writeFileSync(join(data, "exports", "tide", "bad.csv"), "Date,Amount\n2025-01-01,5\n");
  assert.throws(() => build(data), /bad\.csv: not a tide export/);
});

test("reports are written as CSV", () => {
  db = build(data);
  const lines = readFileSync(join(data, "reports", "business_yearly.csv"), "utf8").split("\n");
  assert.equal(lines[2], "2025,7000,583.33,1234.56,5000,20000");
});

test("a plain CSV is loaded as it is", () => {
  db = build(data);
  assert.deepEqual(rows("SELECT bank_id, amount_pence, payee, type FROM transactions WHERE account = 'old-bank'"), [
    ["old-001", -150000, "JANE EXAMPLE", "REPEATPMT"],
    ["old-002", 270000, "ACME CLIENT LTD", "DIRECTDEP"],
  ]);
});

test("uphold keeps the pound side of each row", () => {
  db = build(data);
  const sql = `SELECT bank_id, posted_at, amount_pence, type, payee, status
               FROM transactions WHERE account = 'uphold' ORDER BY posted_at, amount_pence DESC`;
  assert.deepEqual(rows(sql), [
    ["u1", "2026-03-01 09:00:00", 100000, "deposit", "bank", "cleared"],
    ["u2", "2026-03-02 09:00:00", -100000, "buy", "BTC", "cleared"],
    // Crypto bought directly with outside money: a deposit and a purchase.
    ["u3-deposit", "2026-03-02 10:00:00", 50000, "deposit", "bank", "cancelled"],
    ["u3", "2026-03-02 10:00:00", -50000, "buy", "BTC", "cancelled"],
    ["u4-deposit", "2026-03-03 10:00:00", 20000, "deposit", "credit-card", "cleared"],
    ["u4", "2026-03-03 10:00:00", -20000, "buy", "BTC", "cleared"],
    ["u5", "2026-03-04 10:00:00", 65025, "sell", "BTC", "cleared"],
    // u6 is crypto only, so it is skipped. u7 is crypto sold straight out to the bank.
    ["u7", "2026-03-06 10:00:00", 90000, "sell", "BTC", "cleared"],
    ["u7-withdrawal", "2026-03-06 10:00:00", -90000, "withdrawal", "", "cleared"],
  ]);
  assert.deepEqual(rows("SELECT category, total FROM yearly_by_category WHERE tag = 'personal' AND year = '2026'"), [
    ["Crypto bought", -1200],
    ["Crypto sold", 1550.25],
    ["Transfer", 300],
  ]);
});

test("chase rows are read from a folder named in accounts.csv, with their text repaired", () => {
  db = build(data);
  const sql = `SELECT posted_at, amount_pence, type, payee, reference
               FROM transactions WHERE account = 'chase-spending' ORDER BY id`;
  assert.deepEqual(rows(sql), [
    ["2025-02-03 09:01:00", 200000, "Payment", "EXAMPLE TRADING LTD", "Salary"],
    ["2025-02-04 08:15:00", -340, "Purchase", "Corner Café", ""],
    ["2025-02-04 08:15:00", -60, "Transfer", "Round up", ""],
    ["2025-02-04 08:15:00", -340, "Purchase", "Corner Café", ""],
    ["2025-02-04 08:15:00", -60, "Transfer", "Round up", ""],
    // These three are in both exports and are stored once.
    ["2025-02-10 19:30:00", -1000, "Purchase", "Bistro Exemple", "EUR 11.00 | FX rate £1 = €1.1000"],
    ["2025-02-12 10:00:00", -50000, "Transfer", "Savings", ""],
    ["2025-02-20 12:00:00", -40000, "Payment", "Jane Example", "House"],
    ["2025-03-01 02:10:00", 125, "Interest", "Interest earned", ""],
    ["2025-03-03 18:45:00", 2000, "Payment", "Sam & Alex", "dinner"],
  ]);
});

test("chase rows that are the same in every column get ids that differ by a count", () => {
  db = build(data);
  const [first, second] = rows("SELECT bank_id FROM transactions WHERE payee = 'Corner Café' ORDER BY id").map(String);
  assert.match(first, /^[0-9a-f]{16}-1$/);
  assert.equal(second, first.replace(/-1$/, "-2"));
});

test("a chase export whose balances do not follow on is refused", () => {
  const file = join(data, "exports", "chase", "savings", "savings_2025-02-01_2025-03-31.tsv");
  writeFileSync(file, readFileSync(file, "utf8").replace("501.20", "501.21"));
  assert.throws(() => build(data), /savings_2025.*the balance does not follow from the row before on 2025-02-12/);
});

test("an account whose folder does not exist yet is empty", () => {
  appendFileSync(join(data, "accounts.csv"), "chase-later,chase,personal,chase/not-exported-yet\n");
  db = build(data);
  assert.deepEqual(rows("SELECT COUNT(*) FROM transactions WHERE account = 'chase-later'"), [[0]]);
});

test("transfers are paired with their other side", () => {
  db = build(data);
  const sql = `SELECT out_account, in_account, amount, out_category, in_category
               FROM transfer_pairs ORDER BY out_posted_at, out_id`;
  assert.deepEqual(rows(sql), [
    // The business pays the owner: spending on one side, income on the other.
    ["tide", "chase-spending", 2000, "Paid to self", "Paid to self"],
    // Two round-ups alike in every way pair one to one.
    ["chase-spending", "chase-savings", 0.6, "Transfer", "Transfer"],
    ["chase-spending", "chase-savings", 0.6, "Transfer", "Transfer"],
    ["chase-spending", "chase-savings", 500, "Transfer", "Transfer"],
  ]);
});

test("transfer legs with no other side are listed", () => {
  db = build(data);
  assert.deepEqual(rows("SELECT date, account, amount FROM unpaired_transfers"), [
    ["2018-06-28", "old-bank", -1500],
    ["2025-02-20", "chase-spending", -400],
    // Still a payment to the owner, and still one amount, after an override split it.
    ["2025-03-01", "tide", -25000],
    ["2026-03-01", "uphold", 1000],
    ["2026-03-03", "uphold", 200],
    ["2026-03-06", "uphold", -900],
  ]);
  assert.deepEqual(rows("SELECT * FROM transfer_summary WHERE from_account = 'chase-spending'"), [
    ["chase-spending", "(not in the ledger)", 1, 400],
    ["chase-spending", "chase-savings", 3, 501.2],
  ]);
});

test("personal income and spending leave transfers out", () => {
  db = build(data);
  // 2025: pay, interest and a friend paying back come in; two coffees and a meal go out;
  // the 400 sent to an account that is not loaded is the only transfer that does not cancel.
  assert.deepEqual(rows("SELECT * FROM personal_yearly"), [
    ["2025", 2022.05, -16.8, -400, 1605.25],
    ["2026", 1550.25, -1200, 300, 650.25],
  ]);
  assert.deepEqual(rows("SELECT * FROM personal_monthly WHERE month = '2025-02'"), [
    ["2025-02", 2000, -16.8, -400, 1583.2],
  ]);
});
