-- P21 (LV-T01/LV-T02) — opt-in leave email notifications. One knob:
--
-- Workspace.emailLeaveNotifications: when true, the leave chain queues
-- outbox emails alongside its existing in-app notifications —
-- LEAVE_PENDING to the resolved approvers when a request is created
-- (LV-T01, the benchmark's Save event) and LEAVE_DECIDED to the
-- requester when a request is approved or rejected (LV-T02, the
-- benchmark's Submit/status-update event). Delivery is best-effort
-- after the business write (the P18 payslip-email discipline); the
-- in-app Notification rows stay unconditional. Default false = the
-- F-R17 zero-mail posture byte-for-byte.

ALTER TABLE "Workspace" ADD COLUMN "emailLeaveNotifications" BOOLEAN NOT NULL DEFAULT false;
