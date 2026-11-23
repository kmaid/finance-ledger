# finance-ledger

Turns bank exports into one SQLite database and a handful of report CSVs.
Python standard library only, nothing to install.

The code is public; the money is not. Everything personal lives in `data/`,
which git ignores.

## Run it

```
python3 ledger.py
```

This deletes `data/ledger.db`, rebuilds it from the files below, and writes one
CSV per report into `data/reports/`. Nothing is edited in place, so the exports,
rules and overrides are the only things to keep safe.

To try it with made-up data: `python3 ledger.py examples`

## What goes in `data/`

| File | What it is |
| --- | --- |
| `accounts.csv` | One line per account: its folder name, its bank, and a tag (`business` or `personal`). |
| `exports/<account>/*.csv` | Exports from the bank, unedited. Overlapping exports are fine. |
| `rules.csv` | Puts transactions in categories. Optional. |
| `overrides.csv` | Categorises single transactions by hand. Optional. |

`examples/` has a working copy of each.

**Rules** are checked top to bottom and the first match wins. `field` is one of
`payee`, `description`, `reference`, `type`, `bank_category` or `bank_tag`, and
`pattern` is a SQL `LIKE` pattern (`%` matches anything, case does not matter).
A blank `tag` applies the rule to every account.

```
tag,field,pattern,category
business,payee,HMRC%VAT%,VAT
business,payee,HMRC%,Tax
```

**Overrides** beat the rules for one transaction. Leave `amount` blank to move
the whole transaction, or give part of it to split it: the rest keeps the
category from the rules.

```
account,bank_id,category,amount,note
tide,1004,ISA,20000,lump sum of 25000: 20000 ISA and the rest pay
```

## How the figures are made

1. `schema.sql` defines four tables: `accounts`, `transactions`, `rules`, `overrides`.
   They hold what was loaded and nothing else.
2. `views.sql` does all the arithmetic. `categorised` applies the rules, `ledger`
   applies the overrides, and the reports are plain `GROUP BY`s over `ledger`.

Only cleared transactions count. Each run checks that the ledger adds up to the
cleared transactions to the penny and stops if it does not.

| Report | What it shows |
| --- | --- |
| `business_yearly` | Per calendar year: paid to self, average monthly pay (the total over 12), tax, pension, ISA. Reads the categories `Paid to self`, `Tax`, `Pension` and `ISA`. |
| `yearly_by_category` | Totals per tag, year and category. |
| `monthly_by_category` | Totals per tag, month and category. |
| `uncategorised` | Payees no rule matched, biggest first. |

To see the transactions behind any figure:

```
sqlite3 data/ledger.db "SELECT * FROM ledger WHERE category = 'Tax' AND posted_at LIKE '2025%'"
```

## Banks

| Bank | Export |
| --- | --- |
| `tide` | Tide's CSV export with `Transaction ID`, `Paid in` and `Paid out` columns. |

To add a bank, write a `parse_<bank>` function in `ledger.py` that yields the
columns of the `transactions` table, and add it to `PARSERS`. It needs a stable
id per transaction so that overlapping exports do not double count.

## Tests

```
python3 -m unittest discover -s tests
```
