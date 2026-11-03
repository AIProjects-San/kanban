"use client";

import { useState, useMemo } from "react";
import { ChevronLeft, ChevronRight, Plus, MapPin, Clock, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRefresh } from "@/hooks/use-refresh";
import { createEvent, deleteEvent } from "@/server-actions/data";
import { toast } from "sonner";
import { Modal } from "../ui/modal";
import { EntityHistorySection } from "../ui/entity-history-section";
import { Field, FormRow } from "../ui/field";
import { FormActions } from "../ui/form-actions";
import { EVENT_TYPE_MAP, EVENT_TYPES } from "@/lib/config";
import type { CalendarEventT, EventType } from "@/lib/types";

interface CalendarViewProps {
  events: CalendarEventT[];
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function CalendarView({ events }: CalendarViewProps) {
  const today = new Date();
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDate, setSelectedDate] = useState<Date>(today);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailEvent, setDetailEvent] = useState<CalendarEventT | null>(null);
  const refresh = useRefresh();

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  const grid = useMemo(() => {
    // Start from Monday of the week containing the 1st
    const firstOfMonth = new Date(year, month, 1);
    const startOffset = (firstOfMonth.getDay() + 6) % 7; // Mon=0
    const start = new Date(year, month, 1 - startOffset);
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(d);
    }
    return days;
  }, [year, month]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEventT[]>();
    for (const e of events) {
      const k = new Date(e.date).toDateString();
      const arr = map.get(k) ?? [];
      arr.push(e);
      map.set(k, arr);
    }
    return map;
  }, [events]);

  const selectedKey = selectedDate.toDateString();
  const selectedEvents = (eventsByDay.get(selectedKey) ?? []).sort((a, b) =>
    a.time.localeCompare(b.time)
  );

  // Coming up — next 5 events after today
  const upcoming = useMemo(() => {
    const now = new Date(new Date().toDateString());
    return events
      .filter((e) => new Date(e.date) >= now)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime() || a.time.localeCompare(b.time))
      .slice(0, 5);
  }, [events]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Calendar</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {events.length} events scheduled · Click a day to see details
          </p>
        </div>
        <button onClick={() => setCreateOpen(true)} className="f-btn f-btn-primary f-btn-sm">
          <Plus size={15} /> New Event
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Calendar grid */}
        <div className="lg:col-span-2 f-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-foreground">
              {MONTHS[month]} {year}
            </h2>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setCursor(new Date(year, month - 1, 1))}
                className="f-btn f-btn-ghost f-btn-icon"
                aria-label="Previous month"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={() => {
                  setCursor(new Date(today.getFullYear(), today.getMonth(), 1));
                  setSelectedDate(today);
                }}
                className="f-btn f-btn-secondary f-btn-sm"
              >
                Today
              </button>
              <button
                onClick={() => setCursor(new Date(year, month + 1, 1))}
                className="f-btn f-btn-ghost f-btn-icon"
                aria-label="Next month"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-1">
            {WEEKDAYS.map((d) => (
              <div key={d} className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground text-center py-1">
                {d}
              </div>
            ))}
            {grid.map((day, i) => {
              const inMonth = day.getMonth() === month;
              const isToday = day.toDateString() === today.toDateString();
              const isSelected = day.toDateString() === selectedDate.toDateString();
              const dayEvents = eventsByDay.get(day.toDateString()) ?? [];
              return (
                <button
                  key={i}
                  onClick={() => setSelectedDate(day)}
                  className={cn(
                    "min-h-[64px] sm:min-h-[80px] p-1.5 rounded-lg border text-left transition-colors",
                    "hover:border-primary/30 hover:bg-muted/40",
                    isSelected ? "border-primary bg-primary/5" : "border-border",
                    // PR-39 (a11y): out-of-month days used to get opacity-40
                    // on the whole CELL, which dropped the day number and event
                    // chips below WCAG contrast (axe color-contrast). The cell
                    // stays clickable (it selects the date); only the TEXT is
                    // muted now, and muted-foreground itself passes 4.5:1.
                    !inMonth && "border-transparent"
                  )}
                >
                  <div className={cn(
                    "inline-flex items-center justify-center text-xs font-medium w-6 h-6 rounded-full",
                    isToday
                      ? "bg-primary text-primary-foreground"
                      : inMonth
                        ? "text-foreground"
                        : "text-muted-foreground"
                  )}>
                    {day.getDate()}
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {dayEvents.slice(0, 3).map((e) => (
                      <div
                        key={e.id}
                        className={cn("text-[0.625rem] px-1 py-0.5 rounded truncate text-foreground", EVENT_TYPE_MAP[e.type as EventType].bg)}
                      >
                        <span className={cn("inline-block w-1.5 h-1.5 rounded-full mr-1", EVENT_TYPE_MAP[e.type as EventType].dot)} />
                        {e.title}
                      </div>
                    ))}
                    {dayEvents.length > 3 && (
                      <div className="text-[0.625rem] text-muted-foreground px-1">
                        +{dayEvents.length - 3} more
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-3 mt-4 pt-3 border-t border-border flex-wrap">
            {EVENT_TYPES.map((v) => (
              <div key={v.key} className="flex items-center gap-1.5">
                <span className={cn("w-2 h-2 rounded-full", v.dot)} />
                <span className="text-[0.6875rem] text-muted-foreground">{v.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Side — selected day + coming up */}
        <div className="space-y-6">
          <div className="f-card p-5">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">
                {selectedDate.toLocaleDateString("en-NZ", { weekday: "long" })}
              </h2>
              <span className="text-xs text-muted-foreground">
                {selectedDate.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}
              </span>
            </div>
            {selectedEvents.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-xs text-muted-foreground">No events scheduled</p>
                <button
                  onClick={() => setCreateOpen(true)}
                  className="mt-2 text-xs text-primary hover:underline"
                >
                  + Add event
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {selectedEvents.map((e) => (
                  <EventRow key={e.id} event={e} onClick={() => setDetailEvent(e)} onDelete={async () => {
                    const res = await deleteEvent(e.id);
                    if (!res.ok) {
                      toast.error(res.error);
                      return;
                    }
                    refresh();
                    toast.success("Event deleted");
                  }} />
                ))}
              </div>
            )}
          </div>

          <div className="f-card p-5">
            <h2 className="text-sm font-semibold text-foreground mb-3">Coming up</h2>
            <div className="space-y-3">
              {upcoming.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing on the horizon.</p>
              ) : (
                upcoming.map((e) => {
                  const d = new Date(e.date);
                  const style = EVENT_TYPE_MAP[e.type as EventType];
                  return (
                    <div key={e.id} className="flex items-start gap-2.5">
                      <div className="flex flex-col items-center justify-center w-10 py-1 rounded-md bg-muted shrink-0">
                        <span className="text-[0.625rem] uppercase text-muted-foreground leading-none">
                          {d.toLocaleDateString("en-NZ", { month: "short" })}
                        </span>
                        <span className="text-sm font-bold text-foreground leading-none mt-0.5">
                          {d.getDate()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={cn("w-1.5 h-1.5 rounded-full", style.dot)} />
                          <span className="text-xs font-medium text-foreground line-clamp-1">{e.title}</span>
                        </div>
                        <div className="text-[0.625rem] text-muted-foreground mt-0.5">{e.time} · {style.label}</div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      <CreateEventModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        defaultDate={selectedDate}
        onCreated={() => { refresh(); setCreateOpen(false); }}
      />

      {/* Event detail modal with audit history */}
      {detailEvent && (
        <EventDetailModal
          event={detailEvent}
          onClose={() => setDetailEvent(null)}
          onDelete={async () => {
            const res = await deleteEvent(detailEvent.id);
            if (!res.ok) {
              toast.error(res.error);
              return;
            }
            refresh();
            toast.success("Event deleted");
            setDetailEvent(null);
          }}
        />
      )}
    </div>
  );
}

function EventRow({ event, onClick, onDelete }: { event: CalendarEventT; onClick: () => void; onDelete: () => void }) {
  const style = EVENT_TYPE_MAP[event.type as EventType];
  return (
    <div className="group flex items-start gap-3 p-2 rounded-md hover:bg-muted/60 cursor-pointer" onClick={onClick}>
      <div className={cn("w-1 self-stretch rounded-full", style.dot)} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-foreground">{event.title}</div>
        <div className="flex items-center gap-3 text-[0.625rem] text-muted-foreground mt-0.5">
          <span className="flex items-center gap-1"><Clock size={10} /> {event.time} · {event.durationMin}min</span>
          {event.location && (
            <span className="flex items-center gap-1"><MapPin size={10} /> {event.location}</span>
          )}
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="opacity-0 group-hover:opacity-100 text-[0.625rem] text-destructive hover:underline"
      >
        Delete
      </button>
    </div>
  );
}

function CreateEventModal({
  open, onClose, defaultDate, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  defaultDate: Date;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(defaultDate.toISOString().slice(0, 10));
  const [time, setTime] = useState("09:00");
  const [duration, setDuration] = useState(60);
  const [type, setType] = useState<EventType>("MEETING");
  const [location, setLocation] = useState("");

  const submit = async () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    const res = await createEvent({
      title: title.trim(),
      date,
      time,
      durationMin: Number(duration),
      type,
      location,
    });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Event created");
    setTitle("");
    setLocation("");
    onCreated();
  };

  return (
    <Modal open={open} onClose={onClose} title="New calendar event" description="Schedule a meeting, deadline, or focus block" size="md">
      <div className="space-y-4">
        <Field label="Title">
          <input className="f-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sprint planning" />
        </Field>
        <FormRow>
          <Field label="Date">
            <input type="date" className="f-input" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Time">
            <input type="time" className="f-input" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Duration (min)">
            <select className="f-input" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              <option value={30}>30</option>
              <option value={45}>45</option>
              <option value={60}>60</option>
              <option value={90}>90</option>
              <option value={120}>120</option>
            </select>
          </Field>
          <Field label="Type">
            <select className="f-input" value={type} onChange={(e) => setType(e.target.value as EventType)}>
              {EVENT_TYPES.map((v) => (
                <option key={v.key} value={v.key}>{v.label}</option>
              ))}
            </select>
          </Field>
        </FormRow>
        <Field label="Location (optional)">
          <input className="f-input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Google Meet, Room A, etc." />
        </Field>
        <FormActions
          editing={false}
          createLabel="Create event"
          showDelete={false}
          onCancel={onClose}
          onSubmit={submit}
        />
      </div>
    </Modal>
  );
}

function EventDetailModal({
  event,
  onClose,
  onDelete,
}: {
  event: CalendarEventT;
  onClose: () => void;
  onDelete: () => void;
}) {
  const style = EVENT_TYPE_MAP[event.type as EventType];
  const date = new Date(event.date);
  return (
    <Modal open={true} onClose={onClose} title={event.title} description="Event details" size="md">
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/40 border border-border">
          <div className={cn("w-1 self-stretch rounded-full", style.dot)} />
          <div className="flex-1">
            <div className="text-sm font-semibold text-foreground">{event.title}</div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
              <span className="flex items-center gap-1">
                <Clock size={11} /> {event.time} · {event.durationMin}min
              </span>
              <span className={cn("f-badge", style.bg)}>{style.label}</span>
            </div>
            {event.location && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                <MapPin size={11} /> {event.location}
              </div>
            )}
            <div className="text-xs text-muted-foreground mt-1">
              {date.toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
            </div>
          </div>
        </div>

        {/* Audit history */}
        <EntityHistorySection
          entityType="EVENT"
          entityId={event.id}
          entityLabel={event.title}
        />

        <div className="flex items-center justify-between pt-2">
          <button onClick={onDelete} className="f-btn f-btn-ghost f-btn-sm text-destructive">
            <Trash2 size={14} /> Delete event
          </button>
          <button onClick={onClose} className="f-btn f-btn-primary f-btn-sm">Close</button>
        </div>
      </div>
    </Modal>
  );
}
