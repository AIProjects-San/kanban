-- F-R18 down: NOT reversible — the normalization discards each interview
-- event's time-of-day (the HH:MM label column is untouched and still
-- carries it, but the instant cannot be rebuilt from a truncated midnight
-- plus a label that pre-S18 wrote on a server-local basis). The durable
-- fact that mattered — the calendar DAY the event belongs to — is what the
-- up keeps. Re-running the up is idempotent (midnight truncates to
-- midnight), so a rollback followed by a re-up converges to the same state.

SELECT 1;
