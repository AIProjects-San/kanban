"use client";

import { useState, useMemo } from "react";
import { Search, BookOpen, Keyboard, Mail, MessageCircle, ChevronDown, LifeBuoy, Zap, Settings as SettingsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app-store";
import { Modal } from "../ui/modal";
import { APP } from "@/config/app";

const CATEGORIES = [
  { key: "getting-started", label: "Getting Started", icon: Zap, count: 5, color: "text-primary" },
  { key: "tasks", label: "Tasks & Projects", icon: BookOpen, count: 8, color: "text-blue-500" },
  { key: "team", label: "Team & Collaboration", icon: MessageCircle, count: 6, color: "text-pink-500" },
  { key: "settings", label: "Account & Settings", icon: SettingsIcon, count: 7, color: "text-amber-500" },
  { key: "billing", label: "Billing & Plans", icon: LifeBuoy, count: 4, color: "text-emerald-500" },
];

const FAQS = [
  { q: "How do I create a new task?", a: "Click the 'New Task' button on the Tasks page or Dashboard, or press N on your keyboard. You can also click the + icon at the top of any Kanban column to add a task directly to that status.", cat: "tasks" },
  { q: "How do I move a task between columns?", a: "Simply drag the task card from one column to another. The status updates automatically and the assignee's workload is recalculated.", cat: "tasks" },
  { q: "Can I customize the dashboard?", a: "The dashboard layout adapts based on your projects and team activity. To customize appearance, go to Settings → Appearance where you can pick from four accent colors and toggle dark mode.", cat: "getting-started" },
  { q: "How do I add a team member?", a: "Admins: open the Team page and click 'Add Member'. Pick an existing user from the list — they'll appear in the team grid immediately. To create a brand-new user with a login account instead, use the Users page → 'Create user' (or press ⌘K and choose 'Create user').", cat: "team" },
  { q: "What keyboard shortcuts are available?", a: "Press ⌘K (or Ctrl+K) to open the command palette. Press ? anywhere to see all shortcuts. Common ones: N for new task, P for new project, I for inbox, B for notifications, G then D/T/P/C/A/M/S/U/W/H/L to switch views.", cat: "getting-started" },
  { q: "How does the time tracker work?", a: "On the dashboard, click Start in the Time Tracker widget. The timer runs in your browser. Click Stop & Log to record the elapsed time to your selected project.", cat: "tasks" },
  { q: "Can I export analytics data?", a: "Yes. On the Analytics page, click “Export CSV” to download a CSV file of your throughput data for the selected time period (7D, 30D, or 90D).", cat: "settings" },
  { q: "How do I change my accent color?", a: "Go to Settings → Appearance, or open the command palette (⌘K) and search for the theme name. Your choice persists across sessions.", cat: "settings" },
  { q: "How do I filter tasks?", a: "On the Tasks page, use the filter chips at the top to show All tasks, My tasks, High priority, or Due this week.", cat: "tasks" },
  { q: "How do I organize the sidebar?", a: "Sidebar entries are grouped (Overview, Work, People, HR, Administration, General). Click a group heading to expand or collapse it — the group you are working in stays expanded automatically. Click Projects under Work to see all projects you have access to, with search and status filters. Press ⌘B (or Ctrl+B) to collapse the whole sidebar into an icon rail and back.", cat: "getting-started" },
  { q: "What do the calendar event colors mean?", a: "Each event type has a color: Meeting (green), Deadline (red), Review (amber), Social (pink), and Focus (emerald). You can see the legend at the bottom of the calendar grid.", cat: "tasks" },
];

const SHORTCUTS = [
  { keys: ["⌘", "K"], desc: "Open command palette" },
  { keys: ["⌘", "B"], desc: "Toggle sidebar (full ↔ icon rail)" },
  { keys: ["?"], desc: "Show keyboard shortcuts" },
  { keys: ["N"], desc: "New task" },
  { keys: ["P"], desc: "New project" },
  { keys: ["B"], desc: "Open notifications" },
  { keys: ["I"], desc: "Open inbox" },
  { keys: ["G", "D"], desc: "Go to Dashboard" },
  { keys: ["G", "T"], desc: "Go to Tasks" },
  { keys: ["G", "P"], desc: "Go to Projects" },
  { keys: ["G", "C"], desc: "Go to Calendar" },
  { keys: ["G", "A"], desc: "Go to Analytics" },
  { keys: ["G", "M"], desc: "Go to Team" },
  { keys: ["G", "V"], desc: "Go to Leave" },
  { keys: ["G", "N"], desc: "Go to My Payslips" },
  { keys: ["G", "R"], desc: "Go to HR Console (admin, HR, manager)" },
  { keys: ["G", "I"], desc: "Go to Hiring (admin, HR, manager)" },
  { keys: ["G", "Y"], desc: "Go to Payroll (admin, HR)" },
  { keys: ["G", "S"], desc: "Go to Settings" },
  { keys: ["G", "U"], desc: "Go to Users (admin)" },
  { keys: ["G", "W"], desc: "Go to Workspace Config (admin)" },
  { keys: ["G", "L"], desc: "Go to Audit Log" },
  { keys: ["G", "H"], desc: "Go to Help" },
  { keys: ["Esc"], desc: "Close modal / palette" },
];

export function HelpView() {
  const [query, setQuery] = useState("");
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { shortcutsOpen, setShortcutsOpen } = useApp();

  const filteredFaqs = useMemo(() => {
    return FAQS.filter((f) => {
      if (activeCat && f.cat !== activeCat) return false;
      if (query) {
        const q = query.toLowerCase();
        return f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q);
      }
      return true;
    });
  }, [query, activeCat]);

  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground tracking-tight">Help Center</h1>
        <p className="text-sm text-muted-foreground mt-1">Find answers, learn shortcuts, and get support</p>
      </div>

      {/* Search */}
      <div className="f-card p-6 bg-gradient-to-br from-primary/5 to-transparent">
        <div className="relative max-w-xl mx-auto">
          <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for help…"
            className="f-input pl-10 h-12 text-base"
          />
        </div>
        <div className="flex items-center justify-center mt-4">
          <button
            onClick={() => setShortcutsOpen(true)}
            className="text-xs text-primary hover:underline flex items-center gap-1.5"
          >
            <Keyboard size={13} /> View keyboard shortcuts
          </button>
        </div>
      </div>

      {/* Categories */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {CATEGORIES.map((c) => {
          const Icon = c.icon;
          const isActive = activeCat === c.key;
          return (
            <button
              key={c.key}
              onClick={() => setActiveCat(isActive ? null : c.key)}
              className={cn(
                "f-card f-card-hover p-4 text-left transition-all",
                isActive && "border-primary ring-2 ring-primary/20"
              )}
            >
              <Icon size={20} className={c.color} />
              <div className="text-sm font-semibold text-foreground mt-2">{c.label}</div>
              <div className="text-[0.625rem] text-muted-foreground">{c.count} articles</div>
            </button>
          );
        })}
      </div>

      {/* FAQ list */}
      <div className="f-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-foreground">
            {activeCat
              ? CATEGORIES.find((c) => c.key === activeCat)?.label
              : "Frequently asked questions"}
          </h2>
          {activeCat && (
            <button
              onClick={() => setActiveCat(null)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear filter
            </button>
          )}
        </div>
        <div className="space-y-2">
          {filteredFaqs.length === 0 ? (
            <div className="text-center py-10 text-sm text-muted-foreground">
              No articles match “{query}”. Try a different search.
            </div>
          ) : (
            filteredFaqs.map((f, i) => {
              const isOpen = expanded === `${f.q}`;
              return (
                <div key={i} className="border border-border rounded-lg overflow-hidden">
                  <button
                    onClick={() => setExpanded(isOpen ? null : `${f.q}`)}
                    className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-muted/40 transition-colors"
                  >
                    <span className="text-sm font-medium text-foreground">{f.q}</span>
                    <ChevronDown
                      size={16}
                      className={cn("text-muted-foreground transition-transform shrink-0", isOpen && "rotate-180")}
                    />
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-4 text-sm text-muted-foreground leading-relaxed">
                      {f.a}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Contact */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="f-card p-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <Mail size={18} className="text-primary" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">Email support</h3>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Can't find what you're looking for? Drop us a line and we'll get back within 24 hours.
          </p>
          <a href={`mailto:${APP.supportEmail}`} className="text-xs text-primary hover:underline">
            {APP.supportEmail}
          </a>
        </div>
        <div className="f-card p-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-lg bg-pink-500/10 flex items-center justify-center">
              <MessageCircle size={18} className="text-pink-500" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">Community</h3>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Join our community of project managers. Share tips, ask questions, and learn from others.
          </p>
          <button className="text-xs text-primary hover:underline">Join Discord →</button>
        </div>
      </div>

      <Modal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} title="Keyboard shortcuts" description="Speed up your workflow with these shortcuts">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {SHORTCUTS.map((s, i) => (
            <div key={i} className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-muted/40">
              <span className="text-sm text-foreground">{s.desc}</span>
              <div className="flex gap-1">
                {s.keys.map((k, j) => (
                  <kbd key={j} className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded bg-muted border border-border text-foreground">
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
