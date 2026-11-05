"use client";

// Recruitment R1 — the Hiring pipeline board (docs/RECRUITMENT_MODULE_PLAN.md).
// Columns = active template stages; cards = ACTIVE candidates at their
// current stage. Non-active candidates (rejected/withdrawn/hired) live behind
// the status filter. HR/ADMIN get the manage controls (canManage), ADMIN/HR
// get the template editor (canConfig) — MANAGERs are read-only interviewers
// until R2 assigns them stages.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, ChevronRight, FileText, Filter, Mail, Plus, Settings2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { CandidateT, HiringFunnelT, HiringStageConfigT, MailOutboxT, OfferRecordT } from "@/lib/types";
import {
  getHiringBoard,
  getHiringFunnel,
  getHiringPermissions,
  getMailOutbox,
  getMyInterviews,
  getOfferRecords,
} from "@/server-actions/hiring";
import { CandidateModal } from "../ui/candidate-modal";
import { CandidateDetailModal } from "../ui/candidate-detail-modal";
import { OfferBuilderModal } from "../ui/offer-builder-modal";
import { OfferTemplateModal } from "../ui/offer-template-modal";
import { HiringStageModal } from "../ui/hiring-stage-modal";
import { DocumentTypeModal } from "../ui/document-type-modal";
import { computeOffer, formatMoney } from "@/lib/offer-math";

type StatusFilter = "ACTIVE" | "SELECTED" | "REJECTED" | "WITHDRAWN" | "HIRED";

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "ACTIVE", label: "Active" },
  { key: "SELECTED", label: "Selected" },
  { key: "REJECTED", label: "Rejected" },
  { key: "WITHDRAWN", label: "Withdrawn" },
  { key: "HIRED", label: "Hired" },
];

/** The candidate's current stage = first IN_PROGRESS, else first PENDING,
 * else the last completed one (pipeline finished, awaiting decision). */
function currentStageOf(c: CandidateT): CandidateT["stages"][number] | null {
  return (
    c.stages.find((s) => s.status === "IN_PROGRESS") ??
    c.stages.find((s) => s.status === "PENDING") ??
    c.stages[c.stages.length - 1] ??
    null
  );
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

export function HiringView({ currentUser }: { currentUser: { id: string; name: string; role: string } }) {
  const [stages, setStages] = useState<HiringStageConfigT[]>([]);
  const [candidates, setCandidates] = useState<CandidateT[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [canConfig, setCanConfig] = useState(false);
  // P0-6 (D-05/D-18) — mail-provider truth from the permission probe; drives
  // the first-run warning above the outbox (defaults true so a stale probe
  // never flashes the banner — the real action always returns the field).
  const [mailConfigured, setMailConfigured] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>("ACTIVE");
  const [createOpen, setCreateOpen] = useState(false);
  const [editCandidate, setEditCandidate] = useState<CandidateT | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [stageModalOpen, setStageModalOpen] = useState(false);
  const [docTypeModalOpen, setDocTypeModalOpen] = useState(false);
  const [offerTemplateModalOpen, setOfferTemplateModalOpen] = useState(false);
  const [offerBuilderFor, setOfferBuilderFor] = useState<CandidateT | null>(null);
  const [offers, setOffers] = useState<OfferRecordT[]>([]);
  const [myInterviews, setMyInterviews] = useState<Array<{
    stageId: string; stageLabel: string; candidateId: string; candidateName: string;
    position: string; status: string; scheduledAt: string | null;
    rating: number | null; recommendation: string | null;
  }>>([]);
  // R3 — audited candidate-email outbox (hiring:manage only).
  const [outbox, setOutbox] = useState<MailOutboxT[]>([]);
  const [outboxOpenId, setOutboxOpenId] = useState<string | null>(null);
  // R8 — funnel analytics (hiring:view — interviewers included).
  const [funnel, setFunnel] = useState<HiringFunnelT | null>(null);

  const load = useCallback(async () => {
    const [boardRes, permRes] = await Promise.all([
      getHiringBoard(),
      getHiringPermissions(),
    ]);
    if (boardRes.ok) {
      setStages(boardRes.data.stages);
      setCandidates(boardRes.data.candidates);
    } else {
      toast.error(boardRes.error);
    }
    if (permRes.ok) {
      setCanManage(permRes.data.canManage);
      setCanConfig(permRes.data.canConfig);
      setMailConfigured(permRes.data.mailConfigured ?? true);
    }
    // CI-stabilization round 3: the four secondary panels used to load
    // STRICTLY SEQUENTIALLY (outbox → offers → my interviews → funnel), so
    // on a slow dev-mode runner the funnel — last in the chain — could land
    // past the e2e steps' 30 s data windows (the R3 outbox / R8 funnel
    // scenarios timed out in CI while the board itself rendered). The four
    // calls are independent reads: fire them in parallel and the whole view
    // converges in ~one round-trip instead of four.
    const canManage = permRes.ok ? permRes.data.canManage : false;
    const notAllowed = async () => ({ ok: false as const, error: "permission" });
    const [obxRes, offersRes, mineRes, fnRes] = await Promise.all([
      // R3 — outbox + offers are gated behind hiring:manage; skip the fetch
      // otherwise so MANAGERs never trigger a permission-denied error path.
      canManage ? getMailOutbox() : notAllowed(),
      canManage ? getOfferRecords() : notAllowed(),
      getMyInterviews(),
      getHiringFunnel(),
    ]);
    if (obxRes.ok) setOutbox(obxRes.data);
    if (offersRes.ok) setOffers(offersRes.data);
    if (mineRes.ok) setMyInterviews(mineRes.data);
    if (fnRes.ok) setFunnel(fnRes.data);
    setLoaded(true);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const activeStages = useMemo(
    () => stages.filter((s) => s.isActive).sort((a, b) => a.sortOrder - b.sortOrder),
    [stages],
  );

  const activeCandidates = useMemo(
    () => candidates.filter((c) => c.status === "ACTIVE"),
    [candidates],
  );

  const byStage = useMemo(() => {
    const map = new Map<string, CandidateT[]>();
    for (const s of activeStages) map.set(s.key, []);
    for (const c of activeCandidates) {
      const cur = currentStageOf(c);
      const key = cur?.stageKey ?? "";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return map;
  }, [activeStages, activeCandidates]);

  const filtered = useMemo(
    () => candidates.filter((c) => c.status === filter),
    [candidates, filter],
  );

  const detail = detailId ? candidates.find((c) => c.id === detailId) ?? null : null;
  const editing = editCandidate ? candidates.find((c) => c.id === editCandidate.id) ?? editCandidate : null;
  // R6 — does this candidate have a SIGNED offer? Gates "Mark joined" in the
  // detail modal (offers are only loaded for hiring:manage users, which is
  // exactly who can click it).
  const detailHasSignedOffer = detail
    ? offers.some((o) => o.candidateId === detail.id && o.status === "SIGNED")
    : false;

  return (
    <div className="p-6 space-y-5" data-testid="hiring-board">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <UserPlus size={20} /> Hiring pipeline
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {activeCandidates.length} active candidate{activeCandidates.length === 1 ? "" : "s"} across {activeStages.length} stage{activeStages.length === 1 ? "" : "s"}
            {currentUser.role === "MANAGER" && " · interviewer view"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canConfig && (
            <>
              <button className="f-btn f-btn-ghost" onClick={() => setStageModalOpen(true)} data-testid="stage-template-btn">
                <Settings2 size={15} /> Stages
              </button>
              <button className="f-btn f-btn-ghost" onClick={() => setDocTypeModalOpen(true)} data-testid="doc-type-btn">
                <FileText size={15} /> Doc types
              </button>
              <button className="f-btn f-btn-ghost" onClick={() => setOfferTemplateModalOpen(true)} data-testid="offer-template-btn">
                <FileText size={15} /> Offers
              </button>
            </>
          )}
          {canManage && (
            <button className="f-btn f-btn-primary" onClick={() => { setEditCandidate(null); setCreateOpen(true); }} data-testid="add-candidate-btn">
              <Plus size={15} /> Add candidate
            </button>
          )}
        </div>
      </div>

      {/* Status filter (non-active pools) */}
      <div className="flex items-center gap-1.5 flex-wrap" role="tablist" aria-label="Candidate status filter">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              "px-3 py-1.5 rounded-md text-sm transition-colors border",
              filter === f.key
                ? "bg-primary text-primary-foreground border-transparent"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
            data-testid={`hiring-filter-${f.key.toLowerCase()}`}
          >
            {f.label}
            <span className="ml-1.5 text-xs opacity-70">
              {candidates.filter((c) => c.status === f.key).length}
            </span>
          </button>
        ))}
      </div>

      {/* R8 — funnel analytics (hiring:view) */}
      {funnel && (
        <div className="rounded-lg border border-border" data-testid="hiring-funnel">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
            <Filter size={14} className="text-sky-500" />
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">Recruitment funnel</div>
            <span className="text-xs text-muted-foreground ml-auto">
              {funnel.totals.total} candidate{funnel.totals.total === 1 ? "" : "s"} all-time
            </span>
          </div>
          <div className="p-4 grid grid-cols-1 lg:grid-cols-[1fr_1fr_1fr] gap-4">
            {/* Pool totals */}
            <div className="grid grid-cols-3 gap-2 content-start" data-testid="funnel-totals">
              {([
                ["Active", funnel.totals.active],
                ["Selected", funnel.totals.selected],
                ["Hired", funnel.totals.hired],
                ["Rejected", funnel.totals.rejected],
                ["Withdrawn", funnel.totals.withdrawn],
                ["Offers out", funnel.offers.total],
              ] as const).map(([label, value]) => (
                <div key={label} className="rounded-md border border-border px-2.5 py-2">
                  <div className="text-lg font-bold tabular-nums leading-none">{value}</div>
                  <div className="text-[0.625rem] text-muted-foreground mt-1">{label}</div>
                </div>
              ))}
            </div>
            {/* Stage load + velocity */}
            <div data-testid="funnel-stages">
              <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Stages — in progress / passed / avg days</div>
              <div className="space-y-1">
                {funnel.stages.map((s) => (
                  <div key={s.stageKey} className="flex items-center gap-2 text-xs" data-testid={`funnel-stage-${s.stageKey}`}>
                    <span className="min-w-0 truncate flex-1">{s.label}</span>
                    <span className="tabular-nums text-primary font-medium">{s.inStage}</span>
                    <span className="text-muted-foreground">/</span>
                    <span className="tabular-nums text-success">{s.passed}</span>
                    <span className="text-muted-foreground">/</span>
                    <span className="tabular-nums text-muted-foreground w-10 text-right">{s.avgDays === null ? "—" : `${s.avgDays}d`}</span>
                  </div>
                ))}
                {funnel.stages.length === 0 && (
                  <div className="text-xs text-muted-foreground">No stages yet.</div>
                )}
              </div>
            </div>
            {/* Offer funnel */}
            <div data-testid="funnel-offers">
              <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Offers</div>
              <div className="text-3xl font-bold tabular-nums leading-none" data-testid="funnel-accept-rate">
                {funnel.offers.acceptRate === null ? "—" : `${funnel.offers.acceptRate}%`}
              </div>
              <div className="text-[0.625rem] text-muted-foreground mt-1 mb-2">accept rate (decided offers)</div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Awaiting signature</span><span className="tabular-nums font-medium">{funnel.offers.awaiting}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Signed</span><span className="tabular-nums font-medium text-success">{funnel.offers.signed}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Declined</span><span className="tabular-nums font-medium text-destructive">{funnel.offers.declined}</span></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {filter === "ACTIVE" && myInterviews.length > 0 && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3" data-testid="my-interviews">
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
            <CalendarClock size={12} /> Your upcoming interviews
          </div>
          <div className="space-y-1.5">
            {myInterviews.map((m) => (
              <button
                key={m.stageId}
                onClick={() => setDetailId(m.candidateId)}
                className="w-full text-left rounded-md border border-border bg-card px-3 py-2 hover:border-primary/50 transition-colors flex items-center gap-3 text-sm"
              >
                <span className="font-medium">{m.candidateName}</span>
                <span className="text-muted-foreground text-xs">{m.stageLabel}</span>
                <span className="text-xs text-indigo-600 ml-auto">
                  {m.scheduledAt ? new Date(m.scheduledAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "unscheduled"}
                </span>
                <ChevronRight size={14} className="text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>
      )}

      {filter !== "ACTIVE" ? (
        /* Flat pool for decided candidates */
        <div className="space-y-2" data-testid="hiring-pool">
          {filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => setDetailId(c.id)}
              className="w-full text-left rounded-lg border border-border p-3 hover:bg-muted/60 transition-colors flex items-center gap-3"
              data-testid="candidate-card"
            >
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold">
                {initials(c.fullName)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{c.fullName}</div>
                <div className="text-xs text-muted-foreground truncate">{c.position || "Position n/a"}</div>
              </div>
              <div className="text-xs text-muted-foreground max-w-[300px] truncate hidden sm:block">
                {c.status === "REJECTED" && c.rejectReason ? `“${c.rejectReason}”` : ""}
              </div>
              <ChevronRight size={15} className="text-muted-foreground" />
            </button>
          ))}
          {loaded && filtered.length === 0 && (
            <div className="text-sm text-muted-foreground py-6 text-center">No {filter.toLowerCase()} candidates.</div>
          )}
        </div>
      ) : (
        /* Board columns */
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-3 min-w-max">
            {activeStages.map((s) => {
              const cards = byStage.get(s.key) ?? [];
              return (
                <div key={s.key} className="w-[260px] shrink-0" data-testid={`stage-column-${s.key}`}>
                  <div className="rounded-lg bg-muted/50 border border-border p-2.5 mb-2 flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold truncate">{s.label}</div>
                      <div className="text-[0.625rem] text-muted-foreground uppercase tracking-wide">{s.ownerRole}</div>
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">{cards.length}</span>
                  </div>
                  <div className="space-y-2">
                    {cards.map((c) => {
                      const cur = currentStageOf(c);
                      return (
                        <button
                          key={c.id}
                          onClick={() => setDetailId(c.id)}
                          className="w-full text-left rounded-lg border border-border bg-card p-3 hover:border-primary/50 transition-colors"
                          data-testid="candidate-card"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[0.625rem] font-semibold shrink-0">
                              {initials(c.fullName)}
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">{c.fullName}</div>
                              <div className="text-[0.625rem] text-muted-foreground truncate">{c.position || "—"}</div>
                            </div>
                          </div>
                          {cur && cur.status === "IN_PROGRESS" && (
                            <div className="mt-2 text-[0.625rem] px-1.5 py-0.5 rounded bg-primary/10 text-primary inline-block">
                              in progress
                            </div>
                          )}
                        </button>
                      );
                    })}
                    {cards.length === 0 && (
                      <div className="text-xs text-muted-foreground text-center py-4 border border-dashed border-border rounded-lg">
                        Empty
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {loaded && activeStages.length === 0 && (
              <div className="text-sm text-muted-foreground py-6">
                No active stages in the template — {canConfig ? "add some via “Stages”." : "ask an admin to configure the template."}
              </div>
            )}
          </div>
        </div>
      )}

      {/* R5 — offers panel (hiring:manage only) */}
      {canManage && (
        <div className="rounded-lg border border-border" data-testid="offers-panel">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
            <FileText size={14} className="text-emerald-600" />
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Offers
            </div>
            <span className="text-xs text-muted-foreground ml-auto">{offers.length} record{offers.length === 1 ? "" : "s"}</span>
          </div>
          <div className="divide-y divide-border">
            {offers.map((o) => {
              const t = computeOffer(o.components);
              return (
                <button
                  key={o.id}
                  onClick={() => setOfferBuilderFor(candidates.find((c) => c.id === o.candidateId) ?? null)}
                  className="w-full text-left px-4 py-2.5 hover:bg-muted/50 transition-colors flex items-center gap-3 text-sm"
                  data-testid="offer-panel-row"
                >
                  <span className={cn(
                    "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded shrink-0",
                    o.status === "DRAFT" && "bg-amber-500/10 text-amber-600",
                    o.status === "SENT" && "bg-indigo-500/10 text-indigo-600",
                    o.status === "SIGNED" && "bg-emerald-500/10 text-emerald-600",
                    o.status === "DECLINED" && "bg-destructive/10 text-destructive",
                  )}>
                    {o.status}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{o.candidateName} — {o.templateLabel || "Custom offer"}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      CTC {formatMoney(t.ctc)} · net {formatMoney(t.net)}
                      {o.status === "SIGNED" && o.signedName ? ` · signed by ${o.signedName}` : ""}
                      {o.notes ? ` · ${o.notes}` : ""}
                    </span>
                  </span>
                  <ChevronRight size={14} className="text-muted-foreground shrink-0" />
                </button>
              );
            })}
            {offers.length === 0 && (
              <div className="text-sm text-muted-foreground px-4 py-6 text-center">
                No offers yet — generate one from a selected candidate, then send the signing link.
              </div>
            )}
          </div>
        </div>
      )}

      {/* R3 — audited email outbox (hiring:manage only) */}
      {canManage && (
        <>
          {/* P0-6 (D-05/D-18) — first-run guidance: tells HR WHY every send lands
              as SKIPPED before they send one, instead of after. The parent
              column's space-y-5 provides the gap to the outbox below. */}
          {!mailConfigured && (
            <div
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 flex items-start gap-2"
              data-testid="mail-config-warning"
            >
              <Mail size={14} className="shrink-0 mt-0.5" />
              <span>
                <span className="font-semibold">Email delivery is off</span> — no mail provider is configured (set <span className="font-mono text-xs">RESEND_API_KEY</span>). Every candidate send below is recorded as skipped; copy signing links and share them manually.
              </span>
            </div>
          )}
          <div className="rounded-lg border border-border" data-testid="email-outbox">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
            <Mail size={14} className="text-sky-500" />
            <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              Email outbox
            </div>
            <span className="text-xs text-muted-foreground ml-auto">{outbox.length} recorded</span>
          </div>
          <div className="divide-y divide-border">
            {outbox.map((m) => (
              <div key={m.id}>
                <button
                  onClick={() => setOutboxOpenId(outboxOpenId === m.id ? null : m.id)}
                  className="w-full text-left px-4 py-2.5 hover:bg-muted/50 transition-colors flex items-center gap-3 text-sm"
                  data-testid="outbox-row"
                >
                  <span className={cn(
                    "text-[0.625rem] font-semibold px-1.5 py-0.5 rounded shrink-0",
                    m.status === "SENT" && "bg-emerald-500/10 text-emerald-600",
                    m.status === "SKIPPED" && "bg-amber-500/10 text-amber-600",
                    m.status === "FAILED" && "bg-destructive/10 text-destructive",
                    m.status === "QUEUED" && "bg-muted text-muted-foreground",
                  )}>
                    {m.status}
                  </span>
                  <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground shrink-0 hidden sm:inline">{m.kind}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{m.subject}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      to {m.toAddress}{m.candidateName ? ` · ${m.candidateName}` : ""}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0 hidden md:inline">
                    {m.sentBy ?? "—"} · {new Date(m.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <ChevronRight size={14} className={cn("text-muted-foreground transition-transform shrink-0", outboxOpenId === m.id && "rotate-90")} />
                </button>
                {outboxOpenId === m.id && (
                  <div className="px-4 pb-3 text-xs space-y-2" data-testid={`outbox-body-${m.id}`}>
                    <pre className="whitespace-pre-wrap font-sans text-foreground bg-muted/50 rounded-md p-3 border border-border">{m.body}</pre>
                    {m.error && (
                      <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2">
                        Delivery error: {m.error}
                      </div>
                    )}
                    {m.providerMessageId && (
                      <div className="text-muted-foreground">Provider message id: {m.providerMessageId}</div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {outbox.length === 0 && (
              <div className="text-sm text-muted-foreground px-4 py-6 text-center">
                No candidate emails yet — rejection notices you send land here.
              </div>
            )}
          </div>
          </div>
        </>
      )}

      {/* Modals */}
      <CandidateModal
        open={createOpen || editing !== null}
        onClose={() => { setCreateOpen(false); setEditCandidate(null); }}
        onSaved={load}
        edit={editing}
      />
      <CandidateDetailModal
        open={detail !== null}
        onClose={() => setDetailId(null)}
        onChanged={load}
        candidate={detail}
        canManage={canManage}
        onEdit={(c) => { setDetailId(null); setEditCandidate(c); setCreateOpen(true); }}
        onBuildOffer={(c) => { setDetailId(null); setOfferBuilderFor(c); }}
        currentUserId={currentUser.id}
        hasSignedOffer={detailHasSignedOffer}
      />
      <OfferBuilderModal
        open={offerBuilderFor !== null}
        onClose={() => { setOfferBuilderFor(null); void load(); }}
        onChanged={load}
        candidate={offerBuilderFor}
      />
      <HiringStageModal
        open={stageModalOpen}
        onClose={() => setStageModalOpen(false)}
        onChanged={load}
      />
      <DocumentTypeModal
        open={docTypeModalOpen}
        onClose={() => setDocTypeModalOpen(false)}
        onChanged={load}
      />
      <OfferTemplateModal
        open={offerTemplateModalOpen}
        onClose={() => setOfferTemplateModalOpen(false)}
        onChanged={load}
      />
    </div>
  );
}
