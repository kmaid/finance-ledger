/**
 * Rebuild data/ledger.db from the bank exports and write the report CSVs.
 *
 * Usage: node ledger.ts [data-directory]
 *
 * Everything is rebuilt from the files in the data directory on every run, so
 * the database is disposable and the exports, rules and overrides are the truth.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HERE = import.meta.dirname;
const REPORTS = [
  "business_yearly",
  "personal_yearly",
  "personal_monthly",
  "yearly_by_category",
  "monthly_by_category",
  "transfer_summary",
  "unpaired_transfers",
  "uncategorised",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
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

/** Split tab-separated text into records of fields. A field never has a tab in it, so quotes mean nothing here. */
export function parseTsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));
}

/**
 * The text of a file. Some exports have been through a tool that read their
 * UTF-8 as Latin-1 and saved it as UTF-8 again, which turns '£' into 'Â£'.
 * Those start with a mangled byte order mark, and are put right here.
 */
function readText(path: string): string {
  const text = readFileSync(path, "utf8");
  const repaired = text.startsWith("ï»¿") ? Buffer.from(text, "latin1").toString("utf8") : text;
  return repaired.replace(/^\uFEFF/, "");
}

/**
 * Read a .csv or .tsv file with a header line into one object per row.
 * `titleLines` is how many lines the file has above its header.
 */
function readTable(path: string, titleLines = 0): Row[] {
  const records = path.endsWith(".tsv") ? parseTsv(readText(path)) : parseCsv(readText(path));
  const [header = [], ...rest] = records.slice(titleLines);
  return rest.map((record) => Object.fromEntries(header.map((name, i) => [name, record[i] ?? ""])));
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
      // Savings accounts export without the tag column.
      bank_tag: row["Tag 1"] ?? "",
    };
  });
}

/**
 * For one-off imports from a bank that is not worth a parser of its own: a CSV
 * that already has the columns of the transactions table, with the amount in pounds.
 */
function parsePlain(rows: Row[]): Transaction[] {
  return rows.map((row) => ({
    bank_id: column(row, "bank_id"),
    posted_at: column(row, "posted_at"),
    amount_pence: pence(column(row, "amount")),
    description: column(row, "description"),
    payee: column(row, "payee"),
    reference: column(row, "reference"),
    type: column(row, "type"),
    status: column(row, "status"),
    bank_category: column(row, "bank_category"),
    bank_tag: column(row, "bank_tag"),
  }));
}

/**
 * Uphold holds many currencies but the ledger is in pounds, so only the pound
 * side of each row is kept: deposits, withdrawals, and what was paid for or
 * received from crypto. The crypto side is recorded in the description. Rows
 * with no pounds in them (crypto to crypto, rewards, wallet transfers) are skipped.
 */
function parseUphold(rows: Row[]): Transaction[] {
  const transactions: Transaction[] = [];
  for (const row of rows) {
    const from = { amount: column(row, "Origin Amount"), currency: column(row, "Origin Currency") };
    const to = { amount: column(row, "Destination Amount"), currency: column(row, "Destination Currency") };
    if (from.currency !== "GBP" && to.currency !== "GBP") continue;
    const kind = column(row, "Type");
    const line = (suffix: string, type: string, amount: string, sign: 1 | -1, payee: string) => {
      const pounds = Math.round(Number(amount) * 100);
      if (!Number.isFinite(pounds)) throw new Error(`not an amount of money in row ${column(row, "Id")}`);
      transactions.push({
        bank_id: column(row, "Id") + suffix,
        posted_at: new Date(column(row, "Date")).toISOString().slice(0, 19).replace("T", " "),
        amount_pence: sign * pounds,
        description: `${from.amount} ${from.currency} to ${to.amount} ${to.currency}`,
        payee,
        reference: "",
        type,
        status: column(row, "Status") === "completed" ? "cleared" : "cancelled",
        bank_category: "",
        bank_tag: "",
      });
    };
    if (from.currency === "GBP" && to.currency !== "GBP") {
      // Crypto bought with a card or bank payment is a deposit and a purchase in one row.
      if (kind === "in") line("-deposit", "deposit", from.amount, 1, column(row, "Origin"));
      line("", "buy", from.amount, -1, to.currency);
    } else if (from.currency !== "GBP" && kind !== "out") {
      // Crypto sold, or foreign money paid in, arriving as pounds.
      if (kind === "transfer") line("", "sell", to.amount, 1, from.currency);
      else line("", "deposit", to.amount, 1, column(row, "Origin"));
    } else if (from.currency !== "GBP") {
      // Crypto sold and paid straight out to the bank: a sale and a withdrawal in one row.
      line("", "sell", to.amount, 1, from.currency);
      line("-withdrawal", "withdrawal", to.amount, -1, column(row, "Destination"));
    } else if (kind === "out") line("", "withdrawal", from.amount, -1, column(row, "Destination"));
    else line("", "deposit", to.amount, 1, column(row, "Origin"));
  }
  return transactions;
}

/** '5 April 2022' and '9:41' -> '2022-04-05 09:41:00' */
function chaseTime(date: string, time: string): string {
  const [day = "", month = "", year = ""] = date.split(" ");
  const number = MONTHS.indexOf(month) + 1;
  if (number === 0 || !/^\d{1,2}$/.test(day) || !/^\d{4}$/.test(year) || !/^\d{1,2}:\d\d$/.test(time)) {
    throw new Error(`not a date and time: '${date} ${time}'`);
  }
  return `${year}-${String(number).padStart(2, "0")}-${day.padStart(2, "0")} ${time.padStart(5, "0")}:00`;
}

/**
 * Chase gives no transaction id, so one is made from what the row says: a hash
 * of its time, type, description and amount, then a count to tell apart rows
 * that are the same in all four. An export covers whole days, so rows as
 * alike as that are always in the same file and get the same count every time.
 * The balance is left out of the hash, or a late correction to one old row
 * would change the id of every row after it. It is checked instead: each
 * balance must be the one before plus the amount, so a file with a row
 * missing or out of order is refused.
 */
function parseChase(rows: Row[]): Transaction[] {
  const seen = new Map<string, number>();
  let before: number | undefined;
  return rows.map((row) => {
    const posted_at = chaseTime(column(row, "Date"), column(row, "Time"));
    const amount = pence(column(row, "Amount"));
    const balance = pence(column(row, "Balance"));
    if (column(row, "Currency") !== "GBP") throw new Error(`not in pounds on ${posted_at.slice(0, 10)}`);
    if (before !== undefined && before + amount !== balance) {
      throw new Error(`the balance does not follow from the row before on ${posted_at.slice(0, 10)}`);
    }
    before = balance;

    // Payments abroad carry the foreign amount and rate after the type: 'Purchase | EUR 11.00 | FX rate ...'.
    const [type = "", ...foreign] = column(row, "Transaction Type").split(" | ");
    const description = column(row, "Transaction Description").replaceAll("&amp;", "&").trim();
    // 'From A Person - thanks' and 'To A Person - thanks' are the payee and the payer's reference.
    const [payee = "", ...reference] = description.replace(/^(From|To)( |$)/, "").split(" - ");

    const hash = createHash("sha256")
      .update([posted_at, column(row, "Transaction Type"), column(row, "Transaction Description"), amount].join("\t"))
      .digest("hex")
      .slice(0, 16);
    const count = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, count);
    return {
      bank_id: `${hash}-${count}`,
      posted_at,
      amount_pence: amount,
      description,
      payee,
      reference: [reference.join(" - "), ...foreign].filter(Boolean).join(" | "),
      type,
      status: "cleared",
      bank_category: "",
      bank_tag: "",
    };
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The text inside an HTML fragment: tags dropped, entities decoded, runs of space made one. */
function htmlText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|[a-z]+);/gi, (entity, name: string) =>
      name.startsWith("#") ? String.fromCharCode(Number(name.slice(1))) : (ENTITIES[name.toLowerCase()] ?? entity),
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** The cells of every row of the tables in an HTML page. */
export function parseHtmlTable(html: string): string[][] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) =>
    [...row!.matchAll(/<td\b[^>]*?(?:\/>|>([\s\S]*?)<\/td>)/gi)].map(([, cell]) => htmlText(cell ?? "")),
  );
}

/**
 * Santander's "Excel" download is an HTML page in Latin-1 with an .xls name:
 * a few title rows, then a header row starting 'Date', then one row per
 * transaction with blank spacer cells between the columns. The spacers are
 * dropped by keeping only the cells under a header.
 */
function readSantander(path: string): Row[] {
  const records = parseHtmlTable(readFileSync(path, "latin1"));
  const start = records.findIndex((record) => record.includes("Date") && record.includes("Balance"));
  if (start === -1) throw new Error("no header row with 'Date' and 'Balance'");
  const header = records[start]!;
  const columns = header.flatMap((name, i) => (name === "" ? [] : [[name, i] as const]));
  return records
    .slice(start + 1)
    .filter((record) => /^\d\d\/\d\d\/\d{4}$/.test(record[header.indexOf("Date")] ?? ""))
    .map((record) => Object.fromEntries(columns.map(([name, i]) => [name, record[i] ?? ""])));
}

/** '£1,234.56' or '-£1,234.56' -> pence. */
function santanderPence(text: string): number {
  return pence(text.replace("£", ""));
}

/**
 * Santander puts the kind of payment, the other party and the reference in one
 * description. The common shapes are taken apart here; anything else keeps the
 * whole description as its payee.
 */
export function santanderDescription(description: string): { type: string; payee: string; reference: string } {
  const shapes: [RegExp, string][] = [
    [/^DIRECT DEBIT PAYMENT TO (?<payee>.+?) REF (?<reference>.*?)(?:, MANDATE NO \d+)?$/, "Direct debit"],
    [/^STANDING ORDER VIA FASTER PAYMENT TO (?<payee>.+?) REFERENCE (?<reference>.*?)\s*(?:, MANDATE NO \d*)?$/, "Standing order"],
    [/^BILL PAYMENT (?:VIA FASTER PAYMENT )?TO (?<payee>.+?) REFERENCE (?<reference>.*?)\s*(?:, MANDATE NO \d*)?$/, "Payment"],
    [/^FASTER PAYMENTS RECEIPT REF\.?(?<reference>.*?) FROM (?<payee>.+)$/, "Payment"],
    [/^FASTER PAYMENTS RECEIPT FROM (?<payee>.+)$/, "Payment"],
    [/^BANK GIRO CREDIT REF (?<payee>[^,]+),?\s*(?<reference>.*)$/, "Credit"],
    // Older card payments put the amount and rate after the payee: 'TO EDREAMS,209.60 GBP, RATE 1.00/GBP ON ...'.
    [/^CARD PAYMENT TO (?<payee>.+?)(?:,[\d,]+\.\d\d [A-Z]{3}, RATE \S+)?\s+ON \d\d-\d\d-\d{4}$/, "Card payment"],
    [/^(?<payee>.+?) \(VIA (?:GOOGLE|APPLE) PAY\), ON \d\d-\d\d-\d{4}$/, "Card payment"],
    [/^CREDIT FROM (?<payee>.+?) ON \d\d-\d\d-\d{4}$/, "Refund"],
    [/^CASH WITHDRAWAL AT (?<payee>.+?),/, "Cash withdrawal"],
    [/^\d+ Direct Debit Payments? .*Cashback$/, "Cashback"],
    [/^MAINTAINING THE ACCOUNT/, "Fee"],
    [/^INTEREST PAID/, "Interest"],
  ];
  for (const [pattern, type] of shapes) {
    const match = pattern.exec(description);
    if (match) {
      const payee = match.groups?.payee?.trim() ?? "Santander";
      return { type, payee, reference: match.groups?.reference?.trim() ?? "" };
    }
  }
  return { type: "", payee: description, reference: "" };
}

/**
 * Santander gives no transaction id or time, so the id is made the way Chase's
 * is: a hash of the date, description and amount, then a count for rows that
 * are the same in all three. A download covers whole days, so such rows are
 * always in the same file. Rows come newest first; the balances are checked
 * oldest first, each one the one before plus the amount.
 */
function parseSantander(rows: Row[]): Transaction[] {
  const seen = new Map<string, number>();
  let before: number | undefined;
  return rows.toReversed().map((row) => {
    const [day, month, year] = column(row, "Date").split("/");
    const posted_at = `${year}-${month}-${day} 00:00:00`;
    const description = column(row, "Description");
    const amount = santanderPence(column(row, "Money in")) - santanderPence(column(row, "Money Out"));
    const balance = santanderPence(column(row, "Balance"));
    if (before !== undefined && before + amount !== balance) {
      throw new Error(`the balance does not follow from the row before on ${posted_at.slice(0, 10)}`);
    }
    before = balance;
    const hash = createHash("sha256").update([posted_at, description, amount].join("\t")).digest("hex").slice(0, 16);
    const count = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, count);
    return {
      bank_id: `${hash}-${count}`,
      posted_at,
      amount_pence: amount,
      description,
      ...santanderDescription(description),
      status: "cleared",
      bank_category: "",
      bank_tag: "",
    };
  });
}

/**
 * Monzo's CSV export from the app: one row per transaction with Monzo's own
 * id, the date as dd/mm/yyyy and a separate time. Pots are separate accounts
 * in Monzo, so money moved to or from one is a 'Pot transfer' here.
 */
function parseMonzo(rows: Row[]): Transaction[] {
  return rows.map((row) => {
    const [day, month, year] = column(row, "Date").split("/");
    if (column(row, "Currency") !== "GBP") throw new Error(`not in pounds: ${column(row, "Transaction ID")}`);
    return {
      bank_id: column(row, "Transaction ID"),
      posted_at: `${year}-${month}-${day} ${column(row, "Time")}`,
      amount_pence: pence(column(row, "Amount")),
      description: column(row, "Description"),
      payee: column(row, "Name"),
      reference: column(row, "Notes and #tags"),
      type: column(row, "Type"),
      status: "cleared",
      bank_category: column(row, "Category"),
      bank_tag: "",
    };
  });
}

type Bank = {
  parse: (rows: Row[]) => Transaction[];
  /** How many lines a .csv or .tsv file has above its header. */
  titleLines?: number;
  /** Reads a file this bank's way instead of as a .csv or .tsv table. */
  read?: (path: string) => Row[];
};

/** How to read each bank's exports. */
const BANKS: Record<string, Bank> = {
  tide: { parse: parseTide },
  uphold: { parse: parseUphold },
  chase: { parse: parseChase, titleLines: 1 },
  santander: { parse: parseSantander, read: readSantander },
  monzo: { parse: parseMonzo },
  plain: { parse: parsePlain },
};

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
  const accounts = db.prepare("SELECT account, bank, folder FROM accounts").all() as Row[];
  for (const { account, bank, folder: name } of accounts) {
    const reader = BANKS[bank];
    if (!reader) {
      throw new Error(`accounts.csv: no parser for bank '${bank}' (have: ${Object.keys(BANKS).join(", ")})`);
    }
    const folder = join(data, "exports", name);
    const files = existsSync(folder) ? readdirSync(folder).filter((file) => /\.(csv|tsv|xls)$/.test(file)) : [];
    const exports = files.map((file) => {
      try {
        const path = join(folder, file);
        const rows = reader.read ? reader.read(path) : readTable(path, reader.titleLines);
        return { file, transactions: reader.parse(rows) };
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
  readTable(path).forEach((row, index) => {
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
  readTable(path).forEach((row, index) => {
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
    const insertAccount = db.prepare("INSERT INTO accounts VALUES (?, ?, ?, ?)");
    for (const row of readTable(join(data, "accounts.csv"))) {
      insertAccount.run(row.account, row.bank, row.tag, row.folder || row.account);
    }
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
  const { unpaired } = db.prepare("SELECT COUNT(*) AS unpaired FROM unpaired_transfers").get()!;
  console.log(`transfers with no other side: ${unpaired}`);
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
