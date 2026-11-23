/**
 * Rebuild data/ledger.db from the bank exports and write the report CSVs.
 *
 * Usage: node ledger.ts [data-directory]
 *
 * Everything is rebuilt from the files in the data directory on every run, so
 * the database is disposable and the exports, rules and overrides are the truth.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = import.meta.dirname;
const REPORTS = ["business_yearly", "yearly_by_category", "monthly_by_category", "uncategorised"];
const RULE_FIELDS = ["payee", "description", "reference", "type", "bank_category", "bank_tag"];

type Row = Record<string, string>;

/** The columns of the transactions table that a parser has to supply. */
type Transaction = {
  bank_id: string;
  posted_at: string;
  amount_pence: number;
  description: string;
  payee: string;
  reference: string;
  type: string;
  status: string;
  bank_category: string;
  bank_tag: string;
};

/** '4,417.45' -> 441745, without going through floating point. A blank is zero. */
export function pence(text: string): number {
  const clean = text.replaceAll(",", "").trim();
  if (clean === "") return 0;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(clean);
  if (!match) throw new Error(`not an amount of money: '${text}'`);
  const [, sign, pounds, pennies = ""] = match;
  return (sign ? -1 : 1) * (Number(pounds) * 100 + Number(pennies.padEnd(2, "0")));
}

/** Split CSV text into records of fields. Handles quotes, and commas and newlines inside them. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field !== "" || record.length > 0) records.push([...record, field]);
  return records;
}

/** Read a CSV file with a header line into one object per row. */
function readCsv(path: string): Row[] {
  const [header = [], ...records] = parseCsv(readFileSync(path, "utf8").replace(/^﻿/, ""));
  return records.map((record) => Object.fromEntries(header.map((name, i) => [name, record[i] ?? ""])));
}

function toCsv(records: unknown[][]): string {
  const cell = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return records.map((record) => record.map(cell).join(",") + "\n").join("");
}

/** A column of a row, or an error naming the column if the file does not have it. */
function column(row: Row, name: string): string {
  const value = row[name];
  if (value === undefined) throw new Error(`no column '${name}'`);
  return value;
}

// --- Parsers: one per bank. Each turns the rows of an export into transactions.

function parseTide(rows: Row[]): Transaction[] {
  return rows.map((row) => {
    const amount = pence(column(row, "Paid in")) - pence(column(row, "Paid out"));
    return {
      bank_id: column(row, "Transaction ID").replace(/^'/, ""),
      posted_at: column(row, "Date"),
      amount_pence: amount,
      description: column(row, "Transaction description"),
      payee: amount > 0 ? column(row, "From") : column(row, "To"),
      reference: column(row, "Reference"),
      type: column(row, "Transaction type"),
      status: column(row, "Status").toLowerCase(),
      bank_category: column(row, "Category name"),
      bank_tag: column(row, "Tag 1"),
    };
  });
}

const PARSERS: Record<string, (rows: Row[]) => Transaction[]> = { tide: parseTide };

function latest(transactions: Transaction[]): string {
  return transactions.reduce((max, t) => (t.posted_at > max ? t.posted_at : max), "");
}

function loadTransactions(db: DatabaseSync, data: string): void {
  const insert = db.prepare(`
    INSERT INTO transactions (account, bank_id, posted_at, amount_pence, description,
        payee, reference, type, status, bank_category, bank_tag, source_file)
    VALUES (:account, :bank_id, :posted_at, :amount_pence, :description,
        :payee, :reference, :type, :status, :bank_category, :bank_tag, :source_file)
    ON CONFLICT (account, bank_id) DO UPDATE SET
        posted_at = excluded.posted_at, amount_pence = excluded.amount_pence,
        description = excluded.description, payee = excluded.payee,
        reference = excluded.reference, type = excluded.type, status = excluded.status,
        bank_category = excluded.bank_category, bank_tag = excluded.bank_tag,
        source_file = excluded.source_file
  `);
  for (const { account, bank } of db.prepare("SELECT account, bank FROM accounts").all() as Row[]) {
    const parser = PARSERS[bank];
    if (!parser) {
      throw new Error(`accounts.csv: no parser for bank '${bank}' (have: ${Object.keys(PARSERS).join(", ")})`);
    }
    const folder = join(data, "exports", account);
    const files = existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".csv")) : [];
    const exports = files.map((file) => {
      try {
        return { file, transactions: parser(readCsv(join(folder, file))) };
      } catch (error) {
        throw new Error(`${join(folder, file)}: not a ${bank} export this parser understands, ${(error as Error).message}`);
      }
    });
    // Oldest export first, so that when a transaction is in several exports
    // the newest export's version of it (status, category) is the one kept.
    exports.sort((a, b) => latest(a.transactions).localeCompare(latest(b.transactions)));
    for (const { file, transactions } of exports) {
      for (const transaction of transactions) insert.run({ ...transaction, account, source_file: file });
    }
  }
}

function loadRules(db: DatabaseSync, data: string): void {
  const path = join(data, "rules.csv");
  if (!existsSync(path)) return;
  const insert = db.prepare("INSERT INTO rules VALUES (?, ?, ?, ?, ?)");
  readCsv(path).forEach((row, index) => {
    const line = index + 2;
    if (!RULE_FIELDS.includes(row.field)) {
      throw new Error(`rules.csv line ${line}: field must be one of ${RULE_FIELDS.join(", ")}`);
    }
    insert.run(line, row.tag, row.field, row.pattern, row.category);
  });
}

function loadOverrides(db: DatabaseSync, data: string): void {
  const path = join(data, "overrides.csv");
  if (!existsSync(path)) return;
  const find = db.prepare("SELECT 1 FROM transactions WHERE account = ? AND bank_id = ?");
  const insert = db.prepare("INSERT INTO overrides VALUES (?, ?, ?, ?, ?)");
  readCsv(path).forEach((row, index) => {
    if (!find.get(row.account, row.bank_id)) {
      throw new Error(`overrides.csv line ${index + 2}: no transaction ${row.bank_id} in ${row.account}`);
    }
    insert.run(row.account, row.bank_id, row.category, pence(row.amount) || null, row.note);
  });
  const tooMuch = db
    .prepare(`
      SELECT o.bank_id
      FROM overrides o JOIN transactions t USING (account, bank_id)
      GROUP BY o.account, o.bank_id
      HAVING SUM(COALESCE(o.amount_pence, ABS(t.amount_pence))) > ABS(t.amount_pence)
    `)
    .get();
  if (tooMuch) throw new Error(`overrides.csv: overrides add up to more than the transaction for ${tooMuch.bank_id}`);
}

/** Rebuild the database and reports in a data directory. The caller closes the database. */
export function build(data: string): DatabaseSync {
  const database = join(data, "ledger.db");
  rmSync(database, { force: true });
  const db = new DatabaseSync(database);
  try {
    db.exec(readFileSync(join(HERE, "schema.sql"), "utf8"));
    const insertAccount = db.prepare("INSERT INTO accounts VALUES (?, ?, ?)");
    for (const row of readCsv(join(data, "accounts.csv"))) insertAccount.run(row.account, row.bank, row.tag);
    db.exec("BEGIN");
    loadTransactions(db, data);
    loadRules(db, data);
    loadOverrides(db, data);
    db.exec("COMMIT");
    db.exec(readFileSync(join(HERE, "views.sql"), "utf8"));

    // The ledger must account for every cleared penny, no more and no less.
    const total = (view: string) =>
      db.prepare(`SELECT COALESCE(SUM(amount_pence), 0) AS pence FROM ${view}`).get()!.pence;
    if (total("categorised") !== total("ledger")) {
      throw new Error(`ledger does not reconcile: transactions ${total("categorised")}p, ledger ${total("ledger")}p`);
    }

    mkdirSync(join(data, "reports"), { recursive: true });
    for (const view of REPORTS) {
      const statement = db.prepare(`SELECT * FROM ${view}`);
      const header = statement.columns().map((column) => column.name);
      const rows = statement.all().map((row) => header.map((name) => row[name]));
      writeFileSync(join(data, "reports", `${view}.csv`), toCsv([header, ...rows]));
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function main(): void {
  const data = process.argv[2] ?? join(HERE, "data");
  const db = build(data);
  const accounts = db
    .prepare(`
      SELECT account, COUNT(*) AS count, MIN(substr(posted_at, 1, 10)) AS first, MAX(substr(posted_at, 1, 10)) AS last
      FROM transactions GROUP BY account
    `)
    .all();
  for (const { account, count, first, last } of accounts) {
    console.log(`${account}: ${count} transactions, ${first} to ${last}`);
  }
  const { lines, total } = db
    .prepare("SELECT COALESCE(SUM(lines), 0) AS lines, COALESCE(SUM(ABS(total)), 0) AS total FROM uncategorised")
    .get()!;
  const pounds = Number(total).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  console.log(`uncategorised: ${lines} lines worth £${pounds}`);
  console.log(`database: ${join(data, "ledger.db")}`);
  console.log(`reports:  ${join(data, "reports")}`);
  db.close();
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
