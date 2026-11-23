"""Builds a ledger from the made-up data in examples/ and checks the figures."""

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
import ledger  # noqa: E402


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.data = Path(tempfile.mkdtemp()) / "data"
        shutil.copytree(ROOT / "examples", self.data)
        self.addCleanup(shutil.rmtree, self.data.parent)

    def build(self):
        db = ledger.build(self.data)
        self.addCleanup(db.close)
        return db

    def test_transaction_in_two_exports_is_stored_once_with_its_newest_status(self):
        db = self.build()
        self.assertEqual(db.execute("SELECT COUNT(*) FROM transactions").fetchone()[0], 8)
        status = db.execute("SELECT status FROM transactions WHERE bank_id = '1002'").fetchone()[0]
        self.assertEqual(status, "cleared")

    def test_business_yearly_figures(self):
        row = self.build().execute("SELECT * FROM business_yearly").fetchone()
        # Paid to self is 2,000 plus the 5,000 left of the 25,000 lump sum after the ISA override.
        self.assertEqual(row, ("2025", 7000.0, 583.33, 1234.56, 5000.0, 20000.0))

    def test_cancelled_transactions_are_left_out_and_unmatched_ones_are_reported(self):
        db = self.build()
        self.assertEqual(db.execute("SELECT COUNT(*) FROM ledger WHERE payee LIKE 'Hosting%'").fetchone()[0], 0)
        self.assertEqual(db.execute("SELECT payee, total FROM uncategorised").fetchall(),
                         [("Corner Cafe - 1 High Street, London", -8.5)])

    def test_ledger_adds_up_to_the_cleared_transactions(self):
        db = self.build()
        ledger_total = db.execute("SELECT SUM(amount_pence) FROM ledger").fetchone()[0]
        self.assertEqual(ledger_total, 1200000 - 200000 - 123456 - 2500000 - 240000 - 500000 - 850)

    def test_overrides_larger_than_the_transaction_are_refused(self):
        with open(self.data / "overrides.csv", "a") as handle:
            handle.write("tide,1004,Tax,6000,too much\n")
        with self.assertRaises(SystemExit):
            ledger.build(self.data)

    def test_export_with_unknown_columns_is_refused(self):
        (self.data / "exports" / "tide" / "bad.csv").write_text("Date,Amount\n2025-01-01,5\n")
        with self.assertRaises(SystemExit):
            ledger.build(self.data)

    def test_reports_are_written_as_csv(self):
        self.build()
        lines = (self.data / "reports" / "business_yearly.csv").read_text().splitlines()
        self.assertEqual(lines[1], "2025,7000.0,583.33,1234.56,5000.0,20000.0")


if __name__ == "__main__":
    unittest.main()
