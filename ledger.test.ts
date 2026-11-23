// Builds a ledger from the made-up data in examples/ and checks the figures.

import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { build, parseCsv, pence } from "./ledger.ts";

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

test("a transaction in two exports is stored once with its newest status", () => {
  db = build(data);
  assert.deepEqual(rows("SELECT COUNT(*) FROM transactions"), [[8]]);
  assert.deepEqual(rows("SELECT status FROM transactions WHERE bank_id = '1002'"), [["cleared"]]);
});

test("business yearly figures", () => {
  db = build(data);
  // Paid to self is 2,000 plus the 5,000 left of the 25,000 lump sum after the ISA override.
  assert.deepEqual(rows("SELECT * FROM business_yearly"), [["2025", 7000, 583.33, 1234.56, 5000, 20000]]);
});

test("cancelled transactions are left out and unmatched ones are reported", () => {
  db = build(data);
  assert.deepEqual(rows("SELECT COUNT(*) FROM ledger WHERE payee LIKE 'Hosting%'"), [[0]]);
  assert.deepEqual(rows("SELECT payee, total FROM uncategorised"), [["Corner Cafe - 1 High Street, London", -8.5]]);
});

test("the ledger adds up to the cleared transactions", () => {
  db = build(data);
  const expected = 1200000 - 200000 - 123456 - 2500000 - 240000 - 500000 - 850;
  assert.deepEqual(rows("SELECT SUM(amount_pence) FROM ledger"), [[expected]]);
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
  assert.equal(lines[1], "2025,7000,583.33,1234.56,5000,20000");
});
