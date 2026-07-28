import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.ts';
import { formatClock } from '../lib/geo.ts';

export function ChatPanel() {
  const { messages, members, user, stops } = useStore();
  const send = useStore((s) => s.send);
  const markChatRead = useStore((s) => s.markChatRead);

  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => markChatRead(), [messages.length, markChatRead]);

  // Stick to the bottom as new messages land.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    void send(draft);
    setDraft('');
  };

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef}>
        {!messages.length && (
          <div className="empty">
            <div className="empty-icon">💬</div>
            <b>No messages yet</b>
            <div>
              Everything the crew does to the queue shows up here too, so nobody has to ask what
              changed.
            </div>
          </div>
        )}

        {messages.map((m) => {
          if (m.kind === 'system') {
            return (
              <div key={m.id} className="msg-system">
                {m.body}
              </div>
            );
          }
          const author = members.find((mm) => mm.id === m.user_id);
          const mine = m.user_id === user?.id;
          const stop = m.stop_id ? stops.find((s) => s.id === m.stop_id) : null;
          return (
            <div key={m.id} className={`msg ${mine ? 'msg-mine' : ''}`}>
              {!mine && (
                <div
                  className="avatar avatar-sm"
                  style={{ borderColor: author?.color, marginTop: 12 }}
                  title={author?.name}
                >
                  {author?.emoji ?? '👤'}
                </div>
              )}
              <div>
                {!mine && <div className="msg-who">{author?.name ?? 'Someone'}</div>}
                <div className="msg-bubble">
                  {stop && (
                    <div style={{ fontWeight: 650, marginBottom: 2 }}>📍 {stop.name}</div>
                  )}
                  {m.body}
                  <div className="msg-time">{formatClock(m.created_at)}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <form className="chat-compose" onSubmit={submit}>
        <input
          className="input grow"
          value={draft}
          placeholder="Message the car…"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn btn-primary" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
