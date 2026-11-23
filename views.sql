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
