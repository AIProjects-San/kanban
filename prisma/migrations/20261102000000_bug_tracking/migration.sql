-- Bug Tracking — QA engineers raise bugs; developers work them through a
-- full lifecycle. Two new tables: Bug + BugComment.

CREATE TABLE "Bug" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "stepsToReproduce" TEXT NOT NULL DEFAULT '',
    "expectedBehavior" TEXT NOT NULL DEFAULT '',
    "actualBehavior" TEXT NOT NULL DEFAULT '',
    "severity" TEXT NOT NULL DEFAULT 'MAJOR',
    "priority" TEXT NOT NULL DEFAULT 'P2',
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "resolution" TEXT,
    "reporterUserId" TEXT NOT NULL DEFAULT '',
    "assigneeUserId" TEXT,
    "projectId" TEXT,
    "taskId" TEXT,
    "environment" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "triagedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Bug_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Bug_status_idx" ON "Bug"("status");
CREATE INDEX "Bug_severity_idx" ON "Bug"("severity");
CREATE INDEX "Bug_priority_idx" ON "Bug"("priority");
CREATE INDEX "Bug_reporterUserId_idx" ON "Bug"("reporterUserId");
CREATE INDEX "Bug_assigneeUserId_idx" ON "Bug"("assigneeUserId");
CREATE INDEX "Bug_projectId_idx" ON "Bug"("projectId");
CREATE INDEX "Bug_createdAt_idx" ON "Bug"("createdAt");

CREATE TABLE "BugComment" (
    "id" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL DEFAULT '',
    "authorName" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BugComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BugComment_bugId_idx" ON "BugComment"("bugId");
CREATE INDEX "BugComment_authorId_idx" ON "BugComment"("authorId");

ALTER TABLE "BugComment" ADD CONSTRAINT "BugComment_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;
