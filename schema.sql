-- ledger.db is the source of truth. It is kept between runs and backed up
-- before each one; bank exports are imported into it, never the other way round.
-- Every statement here is safe to run on an existing database.
-- All the arithmetic lives in views.sql, which is recreated on every run.

-- Settings and bookkeeping, such as which CSV files were used to fill the tables below.
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
    account TEXT PRIMARY KEY,
    bank    TEXT NOT NULL,     -- which parser reads its files
    tag     TEXT NOT NULL,     -- 'business' or 'personal'
    folder  TEXT NOT NULL      -- where its exports are under data/exports/; the account name unless given
);

-- One row per bank transaction, exactly as the bank reported it. Rows are added
-- and updated by imports and never deleted, so an export can be thrown away.
CREATE TABLE IF NOT EXISTS transactions (
    id            INTEGER PRIMARY KEY,
    account       TEXT NOT NULL REFERENCES accounts (account),
    bank_id       TEXT NOT NULL,     -- the bank's own transaction id, or one made from the row if it has none
    posted_at     TEXT NOT NULL,     -- YYYY-MM-DD HH:MM:SS
    amount_pence  INTEGER NOT NULL,  -- money in is positive, money out is negative
    description   TEXT NOT NULL,
    payee         TEXT NOT NULL,     -- the other party
    reference     TEXT NOT NULL,
    type          TEXT NOT NULL,     -- the bank's transaction type
    status        TEXT NOT NULL,     -- 'cleared', 'pending' or 'cancelled'
    bank_category TEXT NOT NULL,     -- category set in the bank's app
    bank_tag      TEXT NOT NULL,     -- tag set in the bank's app
    source_file   TEXT NOT NULL,     -- the export it last came from
    UNIQUE (account, bank_id)
);

-- The first rule (lowest priority number) that matches wins.
CREATE TABLE IF NOT EXISTS rules (
    priority INTEGER PRIMARY KEY,
    tag      TEXT NOT NULL,        -- only for accounts with this tag; '' means any
    field    TEXT NOT NULL,        -- payee, description, reference, type, bank_category or bank_tag
    pattern  TEXT NOT NULL,        -- SQL LIKE pattern, case-insensitive
    category TEXT NOT NULL
);

-- Puts all or part of one transaction in a category by hand.
CREATE TABLE IF NOT EXISTS overrides (
    account      TEXT NOT NULL,
    bank_id      TEXT NOT NULL,
    category     TEXT NOT NULL,
    amount_pence INTEGER,          -- unsigned part of the transaction; NULL means all of it
    note         TEXT NOT NULL,
    FOREIGN KEY (account, bank_id) REFERENCES transactions (account, bank_id)
);

-- People who rented a room in the owner's home, one row per room and stay.
-- Kept for income tax and for capital gains private residence and letting relief.
CREATE TABLE IF NOT EXISTS lodgers (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    room        TEXT NOT NULL,     -- as the owner names it, e.g. Small, Medium, Large
    rent_pence  INTEGER,           -- per month
    start_month TEXT NOT NULL,     -- YYYY-MM
    end_month   TEXT,              -- YYYY-MM, last month there; NULL while still there
    payee       TEXT,              -- LIKE pattern for their payments in transactions, if any
    shared      TEXT,              -- what they shared with the owner, e.g. kitchen and bathroom
    source      TEXT NOT NULL      -- where this comes from: agreement (Paperless id), spreadsheet, bank
);

-- What each Self Assessment return said about the let rooms. NULL means not known.
CREATE TABLE IF NOT EXISTS tax_returns (
    tax_year              TEXT PRIMARY KEY,   -- e.g. 2015/16
    accountant            TEXT,
    method                TEXT,               -- 'property income' or 'rent-a-room'
    gross_rent_pence      INTEGER,
    expenses_pence        INTEGER,
    property_result       TEXT,               -- as the return gives it, e.g. 'profit 10554, covered by losses'
    total_tax_pence       INTEGER,
    lodgers               TEXT,
    source                TEXT NOT NULL,      -- Paperless ids or emails
    notes                 TEXT
);
