#!/usr/bin/env python3
"""Rebuild data/ledger.db from the bank exports and write the report CSVs.

Usage: python3 ledger.py [data-directory]

Everything is rebuilt from the files in the data directory on every run, so
the database is disposable and the exports, rules and overrides are the truth.
"""

import csv
import sqlite3
import sys
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).parent
REPORTS = ["business_yearly", "yearly_by_category", "monthly_by_category", "uncategorised"]
RULE_FIELDS = {"payee", "description", "reference", "type", "bank_category", "bank_tag"}


def pence(text):
    """'4,417.45' -> 441745. A blank is zero."""
    text = text.replace(",", "").strip()
    return int(Decimal(text) * 100) if text else 0


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


# --- Parsers: one per bank. Each takes the rows of an export and yields dicts
# --- whose keys are the columns of the transactions table.


def parse_tide(rows):
    for row in rows:
        amount = pence(row["Paid in"]) - pence(row["Paid out"])
        yield {
            "bank_id": row["Transaction ID"].lstrip("'"),
            "posted_at": row["Date"],
            "amount_pence": amount,
            "description": row["Transaction description"],
            "payee": row["From"] if amount > 0 else row["To"],
            "reference": row["Reference"],
            "type": row["Transaction type"],
            "status": row["Status"].lower(),
            "bank_category": row["Category name"],
            "bank_tag": row["Tag 1"],
        }


PARSERS = {"tide": parse_tide}


def load_transactions(db, data):
    for account, bank in db.execute("SELECT account, bank FROM accounts").fetchall():
        if bank not in PARSERS:
            sys.exit(f"accounts.csv: no parser for bank '{bank}' (have: {', '.join(PARSERS)})")
        exports = []
        for path in sorted((data / "exports" / account).glob("*.csv")):
            try:
                transactions = list(PARSERS[bank](read_csv(path)))
            except KeyError as missing:
                sys.exit(f"{path}: not a {bank} export this parser understands, no column {missing}")
            if transactions:
                exports.append((max(t["posted_at"] for t in transactions), path, transactions))
        # Oldest export first, so that when a transaction is in several exports
        # the newest export's version of it (status, category) is the one kept.
        for _, path, transactions in sorted(exports, key=lambda export: export[0]):
            for transaction in transactions:
                db.execute(
                    """
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
                    """,
                    {**transaction, "account": account, "source_file": path.name},
                )


def load_rules(db, data):
    path = data / "rules.csv"
    if not path.exists():
        return
    for line, row in enumerate(read_csv(path), start=2):
        if row["field"] not in RULE_FIELDS:
            sys.exit(f"rules.csv line {line}: field must be one of {', '.join(sorted(RULE_FIELDS))}")
        db.execute(
            "INSERT INTO rules VALUES (?, ?, ?, ?, ?)",
            (line, row["tag"], row["field"], row["pattern"], row["category"]),
        )


def load_overrides(db, data):
    path = data / "overrides.csv"
    if not path.exists():
        return
    for line, row in enumerate(read_csv(path), start=2):
        found = db.execute(
            "SELECT ABS(amount_pence) FROM transactions WHERE account = ? AND bank_id = ?",
            (row["account"], row["bank_id"]),
        ).fetchone()
        if not found:
            sys.exit(f"overrides.csv line {line}: no transaction {row['bank_id']} in {row['account']}")
        db.execute(
            "INSERT INTO overrides VALUES (?, ?, ?, ?, ?)",
            (row["account"], row["bank_id"], row["category"], pence(row["amount"]) or None, row["note"]),
        )
    too_much = db.execute(
        """
        SELECT o.bank_id
        FROM overrides o JOIN transactions t USING (account, bank_id)
        GROUP BY o.account, o.bank_id
        HAVING SUM(COALESCE(o.amount_pence, ABS(t.amount_pence))) > ABS(t.amount_pence)
        """
    ).fetchall()
    if too_much:
        sys.exit(f"overrides.csv: overrides add up to more than the transaction for {too_much[0][0]}")


def build(data):
    data = Path(data)
    database = data / "ledger.db"
    database.unlink(missing_ok=True)
    db = sqlite3.connect(database)
    db.executescript((HERE / "schema.sql").read_text())
    for row in read_csv(data / "accounts.csv"):
        db.execute("INSERT INTO accounts VALUES (?, ?, ?)", (row["account"], row["bank"], row["tag"]))
    load_transactions(db, data)
    load_rules(db, data)
    load_overrides(db, data)
    db.executescript((HERE / "views.sql").read_text())
    db.commit()

    # The ledger must account for every cleared penny, no more and no less.
    cleared = db.execute("SELECT COALESCE(SUM(amount_pence), 0) FROM categorised").fetchone()[0]
    in_ledger = db.execute("SELECT COALESCE(SUM(amount_pence), 0) FROM ledger").fetchone()[0]
    if cleared != in_ledger:
        sys.exit(f"ledger does not reconcile: transactions {cleared}p, ledger {in_ledger}p")

    reports = data / "reports"
    reports.mkdir(exist_ok=True)
    for view in REPORTS:
        cursor = db.execute(f"SELECT * FROM {view}")
        with open(reports / f"{view}.csv", "w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(column[0] for column in cursor.description)
            writer.writerows(cursor)
    return db


def main():
    data = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "data"
    db = build(data)
    for account, count, first, last in db.execute(
        "SELECT account, COUNT(*), MIN(substr(posted_at, 1, 10)), MAX(substr(posted_at, 1, 10)) "
        "FROM transactions GROUP BY account"
    ):
        print(f"{account}: {count} transactions, {first} to {last}")
    lines, total = db.execute(
        "SELECT COALESCE(SUM(lines), 0), COALESCE(SUM(ABS(total)), 0) FROM uncategorised"
    ).fetchone()
    print(f"uncategorised: {lines} lines worth £{total:,.2f}")
    print(f"database: {data / 'ledger.db'}")
    print(f"reports:  {data / 'reports'}")


if __name__ == "__main__":
    main()
