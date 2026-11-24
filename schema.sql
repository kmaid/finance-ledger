-- The database is rebuilt from scratch on every run, so there are no migrations.
-- Tables hold what was loaded from data/; all the arithmetic lives in views.sql.

CREATE TABLE accounts (
    account TEXT PRIMARY KEY,
    bank    TEXT NOT NULL,     -- which parser reads its files
    tag     TEXT NOT NULL,     -- 'business' or 'personal'
    folder  TEXT NOT NULL      -- where its exports are under data/exports/; the account name unless given
);

-- One row per bank transaction, exactly as the bank reported it.
CREATE TABLE transactions (
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
    source_file   TEXT NOT NULL,
    UNIQUE (account, bank_id)
);

-- From data/rules.csv. The first rule (lowest priority number) that matches wins.
CREATE TABLE rules (
    priority INTEGER PRIMARY KEY,  -- line number in rules.csv
    tag      TEXT NOT NULL,        -- only for accounts with this tag; '' means any
    field    TEXT NOT NULL,        -- payee, description, reference, type, bank_category or bank_tag
    pattern  TEXT NOT NULL,        -- SQL LIKE pattern, case-insensitive
    category TEXT NOT NULL
);

-- From data/overrides.csv. Puts all or part of one transaction in a category by hand.
CREATE TABLE overrides (
    account      TEXT NOT NULL,
    bank_id      TEXT NOT NULL,
    category     TEXT NOT NULL,
    amount_pence INTEGER,          -- unsigned part of the transaction; NULL means all of it
    note         TEXT NOT NULL,
    FOREIGN KEY (account, bank_id) REFERENCES transactions (account, bank_id)
);
