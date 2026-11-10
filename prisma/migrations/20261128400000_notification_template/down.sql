-- P24 (PL-01) — rollback of the notification template master. Lossless:
-- dropping the table loses only custom template overrides (rendered text,
-- never business data); every event falls back to the built-in defaults.

DROP TABLE "NotificationTemplate";
