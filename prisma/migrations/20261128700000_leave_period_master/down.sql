-- P27 — rollback of the leave period master. Lossless: dropping the master
-- returns the workspace to the implicit calendar-year windows; the ledger,
-- balances, and requests keep every row (buckets are plain integers the
-- period table never owned).

DROP TABLE "LeavePeriod";
