-- Every figure comes from these views. Categories are never stored: they are
-- worked out here from the rules and overrides, so they cannot go stale.

-- Each cleared transaction with the category its first matching rule gives it.
CREATE VIEW categorised AS
SELECT
    t.*,
    a.tag,
    COALESCE(
        (
            SELECT r.category
            FROM rules r
            WHERE (r.tag = '' OR r.tag = a.tag)
              AND CASE r.field
                      WHEN 'payee' THEN t.payee
                      WHEN 'description' THEN t.description
                      WHEN 'reference' THEN t.reference
                      WHEN 'type' THEN t.type
                      WHEN 'bank_category' THEN t.bank_category
                      WHEN 'bank_tag' THEN t.bank_tag
                  END LIKE r.pattern
            ORDER BY r.priority
            LIMIT 1
        ),
        'Uncategorised'
    ) AS rule_category
FROM transactions t
JOIN accounts a USING (account)
WHERE t.status = 'cleared';

-- The ledger: one line per transaction, or several when overrides split it.
-- The lines of a transaction always add up to its amount.
CREATE VIEW ledger AS
SELECT
    c.id AS transaction_id,
    c.account,
    c.tag,
    c.posted_at,
    c.payee,
    c.description,
    o.category,
    CASE
        WHEN o.amount_pence IS NULL THEN c.amount_pence
        WHEN c.amount_pence < 0 THEN -o.amount_pence
        ELSE o.amount_pence
    END AS amount_pence,
    'override' AS decided_by
FROM overrides o
JOIN categorised c USING (account, bank_id)
UNION ALL
-- Whatever the overrides left over keeps the category from the rules.
SELECT *
FROM (
    SELECT
        c.id,
        c.account,
        c.tag,
        c.posted_at,
        c.payee,
        c.description,
        c.rule_category,
        c.amount_pence - (CASE WHEN c.amount_pence < 0 THEN -1 ELSE 1 END) * COALESCE(
            (
                SELECT SUM(COALESCE(o.amount_pence, ABS(c.amount_pence)))
                FROM overrides o
                WHERE o.account = c.account AND o.bank_id = c.bank_id
            ),
            0
        ) AS left_over_pence,
        'rule'
    FROM categorised c
)
WHERE left_over_pence <> 0;

CREATE VIEW monthly_by_category AS
SELECT
    tag,
    substr(posted_at, 1, 7) AS month,
    category,
    COUNT(*) AS lines,
    SUM(amount_pence) / 100.0 AS total
FROM ledger
GROUP BY tag, month, category
ORDER BY tag, month, category;

CREATE VIEW yearly_by_category AS
SELECT
    tag,
    substr(posted_at, 1, 4) AS year,
    category,
    COUNT(*) AS lines,
    SUM(amount_pence) / 100.0 AS total
FROM ledger
GROUP BY tag, year, category
ORDER BY tag, year, category;

-- The business payments tab of the budget spreadsheet, by calendar year.
CREATE VIEW business_yearly AS
SELECT
    substr(posted_at, 1, 4) AS year,
    -SUM(CASE WHEN category = 'Paid to self' THEN amount_pence ELSE 0 END) / 100.0 AS total_paid_to_self,
    ROUND(-SUM(CASE WHEN category = 'Paid to self' THEN amount_pence ELSE 0 END) / 100.0 / 12, 2) AS average_monthly_pay,
    -SUM(CASE WHEN category = 'Tax' THEN amount_pence ELSE 0 END) / 100.0 AS total_tax_paid,
    -SUM(CASE WHEN category = 'Pension' THEN amount_pence ELSE 0 END) / 100.0 AS total_pension,
    -SUM(CASE WHEN category = 'ISA' THEN amount_pence ELSE 0 END) / 100.0 AS total_isa_payments
FROM ledger
WHERE tag = 'business'
GROUP BY year
ORDER BY year;

-- What still needs a rule, biggest first.
CREATE VIEW uncategorised AS
SELECT
    tag,
    payee,
    COUNT(*) AS lines,
    SUM(amount_pence) / 100.0 AS total,
    MIN(substr(posted_at, 1, 10)) AS first_seen,
    MAX(substr(posted_at, 1, 10)) AS last_seen
FROM ledger
WHERE category = 'Uncategorised'
GROUP BY tag, payee
ORDER BY ABS(SUM(amount_pence)) DESC;

-- Money moved between the owner's own accounts is not income or spending, and
-- the rules say which transactions those are: 'Transfer' for a move between
-- accounts with the same tag, and 'Paid to self' on both sides when the
-- business pays the owner. A payment that an override then files under
-- something else, such as ISA, is still one. This is every such transaction,
-- whole even when overrides split it, because the other account sees one amount.
CREATE VIEW transfer_legs AS
SELECT
    c.id AS transaction_id,
    c.account,
    c.posted_at,
    c.payee,
    c.description,
    GROUP_CONCAT(DISTINCT l.category) AS category,
    c.amount_pence,
    -- Tells apart legs that are alike in every way, such as two round-ups of the same pennies in a minute.
    ROW_NUMBER() OVER (PARTITION BY c.account, c.posted_at, c.amount_pence ORDER BY c.id) AS nth
FROM categorised c
JOIN ledger l ON l.transaction_id = c.id
GROUP BY c.id
HAVING c.rule_category IN ('Transfer', 'Paid to self')
    OR SUM(l.category IN ('Transfer', 'Paid to self')) > 0;

-- Proof that a transfer was one: the leg leaving one account next to the leg
-- arriving in another. Two legs are a pair when they are the same amount in
-- different accounts, no more than two days apart, and each is the nearest
-- such leg to the other. A leg is in at most one pair.
CREATE VIEW transfer_pairs AS
SELECT
    amount_pence / 100.0 AS amount,
    out_id,
    out_account,
    out_posted_at,
    out_payee,
    out_category,
    in_id,
    in_account,
    in_posted_at,
    in_payee,
    in_category
FROM (
    SELECT
        i.amount_pence,
        o.transaction_id AS out_id,
        o.account AS out_account,
        o.posted_at AS out_posted_at,
        o.payee AS out_payee,
        o.category AS out_category,
        i.transaction_id AS in_id,
        i.account AS in_account,
        i.posted_at AS in_posted_at,
        i.payee AS in_payee,
        i.category AS in_category,
        ROW_NUMBER() OVER (
            PARTITION BY o.transaction_id
            ORDER BY ABS(julianday(i.posted_at) - julianday(o.posted_at)), ABS(i.nth - o.nth), i.transaction_id
        ) AS choice_of_out,
        ROW_NUMBER() OVER (
            PARTITION BY i.transaction_id
            ORDER BY ABS(julianday(i.posted_at) - julianday(o.posted_at)), ABS(i.nth - o.nth), o.transaction_id
        ) AS choice_of_in
    FROM transfer_legs o
    JOIN transfer_legs i
        ON i.amount_pence = -o.amount_pence
        AND i.account <> o.account
        AND ABS(julianday(i.posted_at) - julianday(o.posted_at)) <= 2
    WHERE o.amount_pence < 0
)
WHERE choice_of_out = 1 AND choice_of_in = 1;

-- Transfer legs with no other side in the ledger. Each is either money moved
-- to or from an account that is not loaded, or something a rule has wrongly
-- called a transfer, so this is the list to read through.
CREATE VIEW unpaired_transfers AS
SELECT
    substr(posted_at, 1, 10) AS date,
    account,
    category,
    payee,
    description,
    amount_pence / 100.0 AS amount
FROM transfer_legs
WHERE transaction_id NOT IN (SELECT out_id FROM transfer_pairs UNION ALL SELECT in_id FROM transfer_pairs)
ORDER BY posted_at, account;

-- How much moved between each two accounts, and how much has no other side.
CREATE VIEW transfer_summary AS
SELECT out_account AS from_account, in_account AS to_account, COUNT(*) AS transfers, SUM(amount) AS total
FROM transfer_pairs
GROUP BY out_account, in_account
UNION ALL
SELECT
    CASE WHEN amount < 0 THEN account ELSE '(not in the ledger)' END,
    CASE WHEN amount < 0 THEN '(not in the ledger)' ELSE account END,
    COUNT(*),
    SUM(ABS(amount))
FROM unpaired_transfers
GROUP BY 1, 2
ORDER BY 1, 2;

-- Personal money in and out with transfers taken out. Transfers between two
-- personal accounts in the ledger cancel, so `transfers` is what went to (minus)
-- or came from accounts that are not loaded. The three add up to `net`, the
-- change in the money held in the personal accounts.
CREATE VIEW personal_monthly AS
SELECT
    substr(posted_at, 1, 7) AS month,
    SUM(CASE WHEN category <> 'Transfer' AND amount_pence > 0 THEN amount_pence ELSE 0 END) / 100.0 AS income,
    SUM(CASE WHEN category <> 'Transfer' AND amount_pence < 0 THEN amount_pence ELSE 0 END) / 100.0 AS spending,
    SUM(CASE WHEN category = 'Transfer' THEN amount_pence ELSE 0 END) / 100.0 AS transfers,
    SUM(amount_pence) / 100.0 AS net
FROM ledger
WHERE tag = 'personal'
GROUP BY month
ORDER BY month;

CREATE VIEW personal_yearly AS
SELECT
    substr(posted_at, 1, 4) AS year,
    SUM(CASE WHEN category <> 'Transfer' AND amount_pence > 0 THEN amount_pence ELSE 0 END) / 100.0 AS income,
    SUM(CASE WHEN category <> 'Transfer' AND amount_pence < 0 THEN amount_pence ELSE 0 END) / 100.0 AS spending,
    SUM(CASE WHEN category = 'Transfer' THEN amount_pence ELSE 0 END) / 100.0 AS transfers,
    SUM(amount_pence) / 100.0 AS net
FROM ledger
WHERE tag = 'personal'
GROUP BY year
ORDER BY year;

-- UK tax year of a timestamp: 6 April to 5 April, written '2019/20'.
-- Each payment from a lodger: a 'Rent received' line whose payee matches a
-- lodger's pattern while they were there. Deposits are told apart by their text.
CREATE VIEW lodger_payments AS
SELECT
    CASE WHEN substr(l.posted_at, 6, 5) >= '04-06'
         THEN substr(l.posted_at, 1, 4) || '/' || substr(CAST(substr(l.posted_at, 1, 4) + 1 AS TEXT), 3, 2)
         ELSE CAST(substr(l.posted_at, 1, 4) - 1 AS TEXT) || '/' || substr(l.posted_at, 3, 2)
    END AS tax_year,
    substr(l.posted_at, 1, 10) AS date,
    p.name AS lodger,
    p.room,
    CASE
        WHEN t.description LIKE '%deposit%' OR t.reference LIKE '%deposit%' THEN 'deposit'
        WHEN l.amount_pence < 0 THEN 'refund'
        ELSE 'rent'
    END AS kind,
    l.amount_pence / 100.0 AS amount,
    l.account,
    t.bank_id
FROM ledger l
JOIN transactions t ON t.id = l.transaction_id
JOIN lodgers p
  ON p.payee IS NOT NULL
 AND l.payee LIKE p.payee
 AND substr(l.posted_at, 1, 7) BETWEEN p.start_month AND COALESCE(p.end_month, '9999-12')
WHERE l.category = 'Rent received';

-- One row per tax year: what the return said next to what the bank and the
-- lodger list show. The bank only goes back to whenever the exports start.
CREATE VIEW rent_by_tax_year AS
WITH years AS (
    SELECT tax_year FROM tax_returns
    UNION SELECT tax_year FROM lodger_payments
),
ranges AS (
    SELECT tax_year,
           substr(tax_year, 1, 4) || '-04' AS first_month,
           CAST(substr(tax_year, 1, 4) + 1 AS TEXT) || '-03' AS last_month
    FROM years
)
SELECT
    r.tax_year,
    (SELECT GROUP_CONCAT(name || ' (' || room || ')', ', ') FROM (
        SELECT DISTINCT name, room FROM lodgers
        WHERE start_month <= r.last_month AND COALESCE(end_month, '9999-12') >= r.first_month
     )) AS lodgers_in_list,
    (SELECT SUM(amount) FROM lodger_payments p WHERE p.tax_year = r.tax_year AND kind = 'rent') AS bank_rent,
    (SELECT SUM(amount) FROM lodger_payments p WHERE p.tax_year = r.tax_year AND kind <> 'rent') AS bank_deposits_and_refunds,
    x.method AS return_method,
    x.gross_rent_pence / 100.0 AS return_gross_rent,
    x.expenses_pence / 100.0 AS return_expenses,
    x.property_result AS return_property_result,
    x.total_tax_pence / 100.0 AS return_total_tax,
    x.accountant,
    x.source,
    x.notes
FROM ranges r
LEFT JOIN tax_returns x USING (tax_year)
ORDER BY r.tax_year;
