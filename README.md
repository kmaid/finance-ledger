# finance-ledger

Turns bank exports into one SQLite database and a handful of report CSVs.
TypeScript on Node 24 or later, which runs it directly and has SQLite built in. No dependencies at run time.

The code is public; the money is not. Everything personal lives in `data/`,
which git ignores.

## Run it

```
node ledger.ts
```

`data/ledger.db` is the source of truth. Each run copies it to `data/backups/`
(the last 20 are kept), imports every bank export into it, recreates the views,
checks that everything reconciles, and writes one CSV per report into
`data/reports/`. Imports add new transactions and update changed ones but never
delete, so an export can be thrown away once it has been imported. Keep
`ledger.db` (and its backups) safe: it holds the rules, overrides and records
that exist nowhere else.

To try it with made-up data: `node ledger.ts examples`

## What goes in `data/`

| File | What it is |
| --- | --- |
| `ledger.db` | The ledger. Everything below is either imported into it or used once to start it. |
| `exports/<folder>/` | Exports from the bank (`.csv`, `.tsv` or Santander's `.xls`), unedited. Overlapping exports are fine. The folder is the account name unless the `accounts` table gives another, such as `chase/spending`. |
| `accounts.csv`, `rules.csv`, `overrides.csv` | Optional starting points. Each fills its table the first time the table is empty; after that the table in `ledger.db` is edited directly (for example with `sqlite3 data/ledger.db`), and a changed CSV is reported, not read. |

`examples/` has a working copy of each.

**Rules** are checked in `priority` order and the first match wins. `field` is one of
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

1. `schema.sql` defines the tables: `accounts`, `transactions`, `rules`,
   `overrides`, and two kept by hand for tax: `lodgers` (who rented a room, when
   and for how much) and `tax_returns` (what each Self Assessment return said
   about the rent). It only ever adds tables, so it runs safely on an existing
   database.
2. `views.sql` does all the arithmetic. `categorised` applies the rules, `ledger`
   applies the overrides, and the reports are plain `GROUP BY`s over `ledger`.

Only cleared transactions count. Each run checks that the ledger adds up to the
cleared transactions to the penny and stops if it does not.

| Report | What it shows |
| --- | --- |
| `business_yearly` | Per calendar year: paid to self, average monthly pay (the total over 12), tax, pension, ISA. Reads the categories `Paid to self`, `Tax`, `Pension` and `ISA`. |
| `personal_yearly`, `personal_monthly` | Personal income, spending and transfers. See below. |
| `yearly_by_category` | Totals per tag, year and category. |
| `monthly_by_category` | Totals per tag, month and category. |
| `transfer_summary` | How many transfers, and how much, went between each two accounts or have no other side. |
| `unpaired_transfers` | Every transfer with no other side in the ledger. |
| `uncategorised` | Payees no rule matched, biggest first. |

Two more views are for tax and are not written as reports: `lodger_payments`
(every `Rent received` line matched to a lodger by their `payee` pattern and the
months they were there) and `rent_by_tax_year` (each tax year's return next to
the lodgers listed and the rent the bank shows).

To see the transactions behind any figure:

```
sqlite3 data/ledger.db "SELECT * FROM ledger WHERE category = 'Tax' AND posted_at LIKE '2025%'"
```

## Transfers between your own accounts

Money moved from one of your accounts to another shows up twice, and is neither
income nor spending. Two categories mark it, and rules assign them like any other:

- `Transfer` for a move between accounts with the same tag: current account to
  savings pot, bank to crypto exchange, or to an account that is not loaded.
- `Paid to self` on both sides when the business pays you. The business rule
  matches your name and the personal rule matches the company's. It is spending
  for the business and income for you, so it stays in the personal figures.

```
personal,type,Transfer,Transfer
personal,payee,EXAMPLE TRADING LTD,Paid to self
personal,payee,%Jane Example%,Transfer
```

`personal_yearly` and `personal_monthly` then give `income` (money in),
`spending` (money out), both without `Transfer` lines, and `transfers`. Transfers
between two loaded personal accounts cancel, so `transfers` is what went to
(minus) or came from accounts that are not loaded. The three add up to `net`,
the change in what the personal accounts hold.

To check that a transfer really was one, the `transfer_pairs` view puts each leg
next to its other side: the same amount, in a different account, within two
days. Whatever has no other side is listed in `unpaired_transfers`. Each of
those went to or came from an account that is not loaded, or is not a transfer
at all and needs a better rule. A payment to yourself that an override files
under something else (`ISA`, say) is still paired, as one whole amount.

```
sqlite3 data/ledger.db "SELECT * FROM transfer_pairs WHERE out_account = 'chase-spending'"
```

## Banks

| Bank | Export |
| --- | --- |
| `tide` | Tide's CSV export with `Transaction ID`, `Paid in` and `Paid out` columns. |
| `uphold` | Uphold's transaction history CSV. Only the pound side of each row is kept: deposits, withdrawals, and crypto bought or sold for pounds. Rows with no pounds in them are skipped. |
| `chase` | Chase UK statement transactions as tab-separated text (`.tsv`): a title line, then `Date`, `Time`, `Transaction Type`, `Transaction Description`, `Amount`, `Currency`, `Balance`. One folder per account or pot. Chase gives no transaction id, so one is made from each row's time, type, description and amount. Each file's balances are checked: every balance must be the one before plus the amount. |
| `santander` | Santander UK's "Download transactions" in Excel format. The `.xls` files are really HTML tables in Latin-1, with `Date`, `Description`, `Money in`, `Money Out` and `Balance`. As with Chase, ids are made from each row (date, description, amount) and each file's balances are checked. The payee, type and reference are taken out of the description. Santander only lets you download about the last seven years. |
| `monzo` | Monzo's CSV export from the app (account ⋮ → Bank statements → CSV). The web app only shows recent transactions and the app fails on long ranges, so export a year at a time. Each row has Monzo's `Transaction ID`. Pots are not exported; moves to and from them are `Pot transfer` lines. |
| `plain` | A CSV you have made yourself with the columns of the `transactions` table and an `amount` in pounds. For one-off imports from a bank that is not worth a parser. See `examples/exports/old-bank/`. |

To add a bank, write a `parse<Bank>` function in `ledger.ts` that returns the
columns of the `transactions` table, and add it to `PARSERS`. It needs a stable
id per transaction so that overlapping exports do not double count.

## Tests

```
pnpm install   # only needed for the type check
pnpm test
pnpm typecheck
```
