"use client";

import { useState, useMemo, useEffect } from "react";
import {
  X, ArrowLeft, Send, Loader2, Inbox as InboxIcon,
} from "lucide-react";
import { useApp } from "@/store/app-store";
import { Avatar } from "./avatar";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { sendMessage, markThreadRead, deleteMessage, getUserByEmail } from "@/server-actions/data";
import type { MessageT, TeamMemberT } from "@/lib/types";

interface InboxDrawerProps {
  messages: MessageT[];
  members: TeamMemberT[];
  currentUser: { name: string; role: string; avatarColor: string };
}

export function InboxDrawer({ messages, members, currentUser }: InboxDrawerProps) {
  const { inboxOpen, setInboxOpen, inboxThreadId, openInboxThread, closeInboxThread, bumpRefresh } = useApp();

  // Group messages into threads
  const threads = useMemo(() => {
    const map = new Map<string, MessageT[]>();
    for (const m of messages) {
      const arr = map.get(m.threadId) ?? [];
      arr.push(m);
      map.set(m.threadId, arr);
    }
    // Sort each thread's messages by date ascending
    for (const [, arr] of map) {
      arr.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    // Sort threads by most recent message
    return Array.from(map.entries())
      .map(([threadId, msgs]) => {
        const last = msgs[msgs.length - 1];
        const hasUnread = msgs.some((m) => m.direction === "IN" && !m.read);
        const member = msgs[0].memberId ? members.find((m) => m.id === msgs[0].memberId) ?? null : null;
        return { threadId, messages: msgs, last, hasUnread, member };
      })
      .sort((a, b) => new Date(b.last.createdAt).getTime() - new Date(a.last.createdAt).getTime());
  }, [messages, members]);

  const unreadCount = messages.filter((m) => m.direction === "IN" && !m.read).length;

  if (!inboxOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
        onClick={() => { setInboxOpen(false); closeInboxThread(); }}
        aria-hidden
      />
      {/* Drawer */}
      <aside
        className="fixed top-0 right-0 z-50 h-screen w-full max-w-md bg-card border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-300"
        role="dialog"
        aria-label="Inbox"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            {inboxThreadId && (
              <button
                onClick={closeInboxThread}
                className="f-btn f-btn-ghost f-btn-icon"
                aria-label="Back to inbox"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                {inboxThreadId ? "Thread" : "Inbox"}
              </h2>
              {!inboxThreadId && (
                <p className="text-[0.625rem] text-muted-foreground">
                  {unreadCount > 0 ? `${unreadCount} unread · ${threads.length} conversations` : `${threads.length} conversations`}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={() => { setInboxOpen(false); closeInboxThread(); }}
            className="f-btn f-btn-ghost f-btn-icon"
            aria-label="Close inbox"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        {inboxThreadId ? (
          <ThreadView
            thread={threads.find((t) => t.threadId === inboxThreadId)}
            members={members}
            currentUser={currentUser}
            onBack={closeInboxThread}
            onReplySent={bumpRefresh}
            onDelete={async (id) => {
              const res = await deleteMessage(id);
              if (!res.ok) {
                toast.error(res.error);
                return;
              }
              bumpRefresh();
              toast.success("Message deleted");
            }}
          />
        ) : (
          <ThreadList
            threads={threads}
            onOpen={(threadId) => openInboxThread(threadId)}
          />
        )}
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// Thread List (inbox view)
// ---------------------------------------------------------------------------

function ThreadList({
  threads,
  onOpen,
}: {
  threads: { threadId: string; messages: MessageT[]; last: MessageT; hasUnread: boolean; member: TeamMemberT | null }[];
  onOpen: (threadId: string) => void;
}) {
  if (threads.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-3">
          <InboxIcon size={24} className="text-muted-foreground" />
        </div>
        <h3 className="text-sm font-semibold text-foreground">No messages yet</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-[240px]">
          Messages from your team will appear here. Send a message from the Team page to start a conversation.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto f-scroll">
      {threads.map((thread) => {
        const first = thread.messages[0];
        const isReply = thread.messages.length > 1;
        return (
          <button
            key={thread.threadId}
            onClick={() => onOpen(thread.threadId)}
            className={cn(
              "w-full flex items-start gap-3 p-4 border-b border-border text-left transition-colors hover:bg-muted/40",
              thread.hasUnread && "bg-primary/5"
            )}
          >
            <div className="relative shrink-0">
              {thread.member ? (
                <Avatar name={first.senderName} color={first.senderAvatarColor} size={40} online={thread.member.online} />
              ) : (
                <Avatar name={first.senderName} color={first.senderAvatarColor} size={40} />
              )}
              {thread.hasUnread && (
                <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-primary border-2 border-card" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-0.5">
                <span className={cn("text-sm truncate", thread.hasUnread ? "font-semibold text-foreground" : "font-medium text-foreground")}>
                  {first.direction === "IN" ? first.senderName : `To: ${first.recipientName}`}
                </span>
                <span className="text-[0.625rem] text-muted-foreground shrink-0">
                  {formatDate(thread.last.createdAt)}
                </span>
              </div>
              <div className={cn("text-xs truncate mb-1", thread.hasUnread ? "font-medium text-foreground" : "text-muted-foreground")}>
                {first.subject}
                {isReply && thread.last.direction === "OUT" && " · You replied"}
              </div>
              <div className="text-[0.6875rem] text-muted-foreground line-clamp-1">
                {thread.last.body.split("\n")[0]}
              </div>
              {thread.messages.length > 1 && (
                <div className="flex items-center gap-1 mt-1.5">
                  <span className="text-[0.625rem] text-muted-foreground">
                    {thread.messages.length} messages
                  </span>
                  {thread.messages.filter(m => m.direction === "IN" && !m.read).length > 0 && (
                    <span className="text-[0.625rem] font-semibold text-primary">
                      · {thread.messages.filter(m => m.direction === "IN" && !m.read).length} unread
                    </span>
                  )}
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread View (conversation + reply)
// ---------------------------------------------------------------------------

function ThreadView({
  thread,
  members,
  currentUser,
  onBack,
  onReplySent,
  onDelete,
}: {
  thread: { threadId: string; messages: MessageT[]; last: MessageT; hasUnread: boolean; member: TeamMemberT | null } | undefined;
  members: TeamMemberT[];
  currentUser: { name: string; role: string; avatarColor: string };
  onBack: () => void;
  onReplySent: () => void;
  onDelete: (id: string) => void;
}) {
  const [replyBody, setReplyBody] = useState("");
  const [sending, setSending] = useState(false);

  // Mark thread as read when opened
  useEffect(() => {
    if (thread?.hasUnread) {
      markThreadRead(thread.threadId);
    }
  }, [thread?.threadId]);

  if (!thread) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Thread not found
      </div>
    );
  }

  const first = thread.messages[0];
  const replyTo = first.direction === "IN" ? first.senderName : first.recipientName;
  const replyToColor = first.direction === "IN" ? first.senderAvatarColor : "forest";
  const memberId = first.memberId;

  const sendReply = async () => {
    if (!replyBody.trim()) {
      toast.error("Reply body is required");
      return;
    }
    setSending(true);
    try {
      // Look up the recipient's user ID
      const recipientRes = await getUserByEmail(
        // The replyTo is the other person in the conversation — find their email
        // from the members list if possible, otherwise leave recipientUserId empty
        members.find((m) => m.name === replyTo)?.email ?? ""
      );
      const recipientUser = recipientRes.ok ? recipientRes.data : null;
      const res = await sendMessage({
        direction: "OUT",
        threadId: thread.threadId,
        memberId,
        senderName: currentUser.name,
        senderAvatarColor: currentUser.avatarColor,
        senderRole: currentUser.role,
        recipientName: replyTo,
        recipientUserId: recipientUser?.id,
        subject: first.subject.startsWith("Re:") ? first.subject : `Re: ${first.subject}`,
        body: replyBody.trim(),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setReplyBody("");
      toast.success(`Reply sent to ${replyTo}`);
      onReplySent();
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {/* Messages */}
      <div className="flex-1 overflow-y-auto f-scroll p-4 space-y-4">
        {/* Subject header */}
        <div className="pb-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">{first.subject}</h3>
          <p className="text-[0.625rem] text-muted-foreground mt-0.5">
            Conversation with {replyTo} · {thread.messages.length} {thread.messages.length === 1 ? "message" : "messages"}
          </p>
        </div>

        {/* Message bubbles */}
        {thread.messages.map((msg) => {
          const isOutgoing = msg.direction === "OUT";
          return (
            <div key={msg.id} className="group">
              <div className="flex items-start gap-2.5 mb-1.5">
                <Avatar name={msg.senderName} color={msg.senderAvatarColor} size={28} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground">
                      {isOutgoing ? "You" : msg.senderName}
                    </span>
                    <span className="text-[0.625rem] text-muted-foreground shrink-0">
                      {formatDateTime(msg.createdAt)}
                    </span>
                  </div>
                  {msg.senderRole && !isOutgoing && (
                    <div className="text-[0.625rem] text-muted-foreground">{msg.senderRole}</div>
                  )}
                </div>
              </div>
              <div className={cn(
                "rounded-lg p-3 text-sm leading-relaxed whitespace-pre-wrap",
                isOutgoing
                  ? "bg-primary text-primary-foreground ml-9"
                  : "bg-muted text-foreground ml-9"
              )}>
                {msg.body}
              </div>
              <div className="flex items-center justify-end mt-1 mr-1">
                <button
                  onClick={() => onDelete(msg.id)}
                  className="opacity-0 group-hover:opacity-100 text-[0.625rem] text-muted-foreground hover:text-destructive transition-opacity"
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Reply form */}
      <div className="border-t border-border p-4 shrink-0">
        <div className="flex items-start gap-2.5">
          <Avatar name={currentUser.name} color={currentUser.avatarColor} size={28} />
          <div className="flex-1">
            <textarea
              autoFocus
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              placeholder={`Reply to ${replyTo}…`}
              className="f-input min-h-[72px] py-2 resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  sendReply();
                }
              }}
            />
            <div className="flex items-center justify-between mt-2">
              <span className="text-[0.625rem] text-muted-foreground">
                ⌘+Enter to send
              </span>
              <button
                onClick={sendReply}
                disabled={sending || !replyBody.trim()}
                className="f-btn f-btn-primary f-btn-sm"
              >
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {sending ? "Sending…" : "Reply"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHrs < 24) return `${diffHrs}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return d.toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-NZ", { day: "numeric", month: "short" }) +
    " · " +
    d.toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit" });
}
