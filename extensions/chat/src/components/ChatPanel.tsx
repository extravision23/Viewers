import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getAgentOperations, sendAgentMessage } from '../api/agentClient';
import type { AgentAttachment, AgentForm as AgentFormData, AgentOperation } from '../api/agentClient';
import Markdown from './Markdown';

const OPERATIONS_POLL_MS = 8000;
const _ACTIVE_OP_STATUSES = new Set(['InQueue', 'InProgress']);

function OperationsPopup({ operations }: { operations: AgentOperation[] }) {
  return (
    <div className="absolute right-2 top-10 z-10 w-64 rounded border border-gray-700 bg-gray-900 p-2 shadow-lg">
      <div className="mb-1 text-xs font-semibold text-white">Background tasks</div>
      {operations.length === 0 ? (
        <div className="text-xs text-gray-400">No active tasks.</div>
      ) : (
        <ul className="space-y-1">
          {operations.map((op, i) => (
            <li key={`${op.kind}-${i}`} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-gray-200">{op.label}</span>
              <span
                className={
                  'rounded px-1.5 py-0.5 ' +
                  (_ACTIVE_OP_STATUSES.has(op.status)
                    ? 'bg-blue-700/60 text-blue-100'
                    : op.status === 'Completed'
                      ? 'bg-green-700/60 text-green-100'
                      : op.status === 'Failed'
                        ? 'bg-red-700/60 text-red-100'
                        : 'bg-gray-700 text-gray-200')
                }
              >
                {op.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Role = 'user' | 'assistant';
interface ChatMessage {
  role: Role;
  content: string;
  form?: AgentFormData;
  // Filenames only, for display/history — never the file bytes (kept out of
  // localStorage, see PersistedState).
  attachments?: string[];
  // Set client-side at creation time — epoch ms.
  timestamp: number;
}
interface PersistedState {
  threadId: string;
  messages: ChatMessage[];
}

const _KYIV_TIME_FORMAT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatKyivTime(timestamp: number): string {
  // uk-UA gives "25.07.2026, 14:32" — drop the comma for a tighter chat timestamp.
  return _KYIV_TIME_FORMAT.format(new Date(timestamp)).replace(',', '');
}

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // keep in sync with agent_server.py's cap

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // "data:application/pdf;base64,AAAA..." — we only want the payload.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

const STORAGE_PREFIX = 'xv-ai-chat:';

function storageKey(studyInstanceUID: string): string {
  return `${STORAGE_PREFIX}${studyInstanceUID}`;
}

function loadState(studyInstanceUID: string): PersistedState | null {
  try {
    const raw = window.localStorage.getItem(storageKey(studyInstanceUID));
    return raw ? (JSON.parse(raw) as PersistedState) : null;
  } catch {
    return null;
  }
}

function saveState(studyInstanceUID: string, state: PersistedState): void {
  try {
    window.localStorage.setItem(storageKey(studyInstanceUID), JSON.stringify(state));
  } catch {
    /* localStorage may be unavailable/full — non-fatal for the chat */
  }
}

function newThreadId(studyInstanceUID: string): string {
  return `ich-${studyInstanceUID.slice(-8)}-${Date.now()}`;
}

/** Resolve the current study — prefer the URL (study-level, ready at mount). */
function resolveStudyInstanceUID(servicesManager: any): string | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('StudyInstanceUIDs');
    if (fromUrl) {
      return fromUrl.split(',')[0];
    }
  } catch {
    /* ignore */
  }
  try {
    const active = servicesManager?.services?.displaySetService?.getActiveDisplaySets?.();
    if (active && active.length) {
      return active[0].StudyInstanceUID;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function AgentFormFields({
  form,
  disabled,
  onSubmit,
}: {
  form: AgentFormData;
  disabled: boolean;
  onSubmit: (text: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  const handleSubmit = () => {
    const lines = form.fields
      .map(f => [f.label, (values[f.key] || '').trim()] as const)
      .filter(([, v]) => v !== '')
      .map(([label, v]) => `${label}: ${v}`);
    if (lines.length === 0) {
      return;
    }
    onSubmit(lines.join('\n'));
  };

  return (
    <div className="mt-2 space-y-2 rounded border border-gray-700 bg-gray-900 p-2">
      {form.title && <div className="text-xs font-semibold text-white">{form.title}</div>}
      {form.fields.map(f => (
        <div key={f.key} className="flex flex-col gap-0.5">
          <label className="text-xs text-gray-300">{f.label}</label>
          {/* Shown as persistent text, not just a placeholder — a placeholder
              vanishes once the field has a value/focus, hiding a computed
              result (e.g. "Computed from imaging: SUPRATENTORIAL") right when
              the doctor needs it to decide what to type. */}
          {f.hint && <div className="text-[11px] text-amber-300">{f.hint}</div>}
          <input
            className="rounded border border-gray-600 bg-black px-2 py-1 text-xs text-white placeholder:text-gray-500 outline-none focus:border-blue-500"
            style={{ color: '#fff', caretColor: '#fff' }}
            value={values[f.key] || ''}
            disabled={disabled}
            onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
        </div>
      ))}
      <button
        className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
        disabled={disabled}
        onClick={handleSubmit}
      >
        Submit
      </button>
    </div>
  );
}

function ChatPanel({ servicesManager }: { servicesManager?: any }) {
  const studyInstanceUID = resolveStudyInstanceUID(servicesManager);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<AgentAttachment[]>([]);
  const [operations, setOperations] = useState<AgentOperation[]>([]);
  const [opsPopupOpen, setOpsPopupOpen] = useState(false);

  const threadIdRef = useRef<string>('');
  const initStartedRef = useRef<string | null>(null); // study for which init was kicked off
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // True while any polled operation is still InQueue/InProgress — used to
  // detect the "just finished" transition below, and reset whenever a fresh
  // batch of operations starts (new thread, new turn).
  const hadActiveOpsRef = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  // Live status poll for background tasks (segmentation + volume/midline-shift
  // gather) — independent of the chat turn cycle, so the popup reflects
  // progress even while the doctor isn't actively messaging. Also the
  // trigger for auto-advancing the chat: when everything that was pending
  // resolves, silently send the same "check status" a doctor would otherwise
  // have to type — no fake user bubble, just the assistant's next message
  // appearing on its own once results are ready.
  useEffect(() => {
    if (!studyInstanceUID) {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const threadId = threadIdRef.current;
      if (!threadId) {
        return;
      }
      try {
        const res = await getAgentOperations(threadId);
        if (cancelled) {
          return;
        }
        setOperations(res.operations);

        const stillActive = res.operations.some(op => _ACTIVE_OP_STATUSES.has(op.status));
        if (hadActiveOpsRef.current && !stillActive && !loadingRef.current) {
          // "status" hits the deterministic fast-path in the segmentation/
          // gathering wait (no LLM classification ambiguity on an empty
          // message) — same trigger as a doctor typing "check now".
          runTurn('status', messagesRef.current);
        }
        hadActiveOpsRef.current = stillActive;
      } catch {
        // Transient poll failure — leave last-known state, try again next tick.
      }
    };
    poll();
    const interval = setInterval(poll, OPERATIONS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [studyInstanceUID, messages, loading]);

  // One round-trip to the agent; appends the reply (plus its form, if any) and persists.
  const runTurn = useCallback(
    async (message: string | null, baseMessages: ChatMessage[], attachments?: AgentAttachment[]) => {
      if (!studyInstanceUID) {
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await sendAgentMessage({
          studyInstanceUID,
          threadId: threadIdRef.current,
          message,
          attachments,
        });
        threadIdRef.current = res.threadId;
        const next = [
          ...baseMessages,
          { role: 'assistant' as Role, content: res.reply, form: res.form, timestamp: Date.now() },
        ];
        setMessages(next);
        saveState(studyInstanceUID, { threadId: res.threadId, messages: next });
      } catch (e: any) {
        setError(e?.message || 'Failed to reach the assistant.');
      } finally {
        setLoading(false);
      }
    },
    [studyInstanceUID]
  );

  // Load persisted chat or auto-run the first step when the study opens.
  useEffect(() => {
    if (!studyInstanceUID) {
      return;
    }
    const persisted = loadState(studyInstanceUID);
    if (persisted) {
      threadIdRef.current = persisted.threadId || newThreadId(studyInstanceUID);
      setMessages(persisted.messages || []);
      if ((persisted.messages || []).length > 0) {
        return; // already initialized — don't re-trigger the first step
      }
    } else {
      threadIdRef.current = newThreadId(studyInstanceUID);
    }

    // Auto-run the agent's first step with the study as context.
    if (initStartedRef.current !== studyInstanceUID) {
      initStartedRef.current = studyInstanceUID;
      runTurn(null, []);
    }
  }, [studyInstanceUID, runTurn]);

  // Keep the transcript scrolled to the latest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if ((!text && pendingAttachments.length === 0) || loading) {
      return;
    }
    const next = [
      ...messages,
      {
        role: 'user' as Role,
        content: text,
        timestamp: Date.now(),
        ...(pendingAttachments.length ? { attachments: pendingAttachments.map(a => a.filename) } : {}),
      },
    ];
    setMessages(next);
    setInput('');
    const attachments = pendingAttachments;
    setPendingAttachments([]);
    runTurn(text, next, attachments);
  }, [input, loading, messages, pendingAttachments, runTurn]);

  const handleFilesSelected = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) {
        return;
      }
      const accepted: AgentAttachment[] = [];
      const rejections: string[] = [];
      for (const file of Array.from(files)) {
        if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
          rejections.push(`${file.name}: only PDF files are supported`);
          continue;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          rejections.push(`${file.name}: too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB)`);
          continue;
        }
        try {
          const dataBase64 = await fileToBase64(file);
          accepted.push({ filename: file.name, contentType: file.type || 'application/pdf', dataBase64 });
        } catch {
          rejections.push(`${file.name}: couldn't read file`);
        }
      }
      if (accepted.length) {
        setPendingAttachments(prev => [...prev, ...accepted]);
      }
      setError(rejections.length ? rejections.join('; ') : null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    []
  );

  const removePendingAttachment = useCallback((filename: string) => {
    setPendingAttachments(prev => prev.filter(a => a.filename !== filename));
  }, []);

  // Submission from an interactive form (see AgentFormFields) — same path as
  // typing a reply, just with the composed "Label: value" lines as the text.
  const handleFormSubmit = useCallback(
    (text: string) => {
      if (!text || loading) {
        return;
      }
      const next = [...messages, { role: 'user' as Role, content: text, timestamp: Date.now() }];
      setMessages(next);
      runTurn(text, next);
    },
    [loading, messages, runTurn]
  );

  // Clear the conversation, start a new thread, and re-run the first step.
  const handleReset = useCallback(() => {
    if (!studyInstanceUID || loading) {
      return;
    }
    try {
      window.localStorage.removeItem(storageKey(studyInstanceUID));
    } catch {
      /* ignore */
    }
    threadIdRef.current = newThreadId(studyInstanceUID);
    initStartedRef.current = studyInstanceUID;
    setMessages([]);
    setInput('');
    setError(null);
    runTurn(null, []);
  }, [studyInstanceUID, loading, runTurn]);

  if (!studyInstanceUID) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-gray-300">
        Open a study to start the AI assistant.
      </div>
    );
  }

  const activeOpCount = operations.filter(op => _ACTIVE_OP_STATUSES.has(op.status)).length;

  return (
    <div className="flex h-full max-h-full flex-col overflow-hidden bg-black text-gray-100">
      <div className="relative flex shrink-0 items-center justify-between border-b border-gray-700 px-3 py-2">
        <span className="text-sm font-semibold text-white">AI Assistant</span>
        <div className="flex items-center gap-1">
          <button
            className="relative rounded px-2 py-1 text-xs text-gray-300 hover:bg-gray-700"
            onClick={() => setOpsPopupOpen(v => !v)}
            title="Background tasks"
          >
            Background tasks{activeOpCount > 0 ? ` (${activeOpCount})` : ''}
          </button>
          <button
            className="rounded px-2 py-1 text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-50"
            disabled={loading}
            onClick={handleReset}
            title="Start a new conversation for this study"
          >
            Reset
          </button>
        </div>
        {opsPopupOpen && <OperationsPopup operations={operations} />}
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
      >
        {messages.length === 0 && !loading && (
          <div className="text-sm text-gray-400">Preparing study analysis…</div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
          >
            <div
              className={
                'max-w-[85%] rounded-lg px-3 py-2 text-sm ' +
                (m.role === 'user'
                  ? 'whitespace-pre-wrap bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-100')
              }
            >
              {m.attachments && m.attachments.length > 0 && (
                <div className="mb-1 flex flex-wrap gap-1">
                  {m.attachments.map(name => (
                    <span
                      key={name}
                      className="rounded bg-blue-700/60 px-1.5 py-0.5 text-xs text-blue-100"
                    >
                      📎 {name}
                    </span>
                  ))}
                </div>
              )}
              {m.role === 'user' ? m.content : <Markdown text={m.content} />}
              {m.role === 'assistant' && m.form && i === messages.length - 1 && (
                <AgentFormFields form={m.form} disabled={loading} onSubmit={handleFormSubmit} />
              )}
              {m.timestamp && (
                <div
                  className={
                    'mt-1 text-[10px] ' + (m.role === 'user' ? 'text-blue-200/70' : 'text-gray-400')
                  }
                >
                  {formatKyivTime(m.timestamp)}
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-400">…</div>
          </div>
        )}
        {error && <div className="text-sm text-red-400">{error}</div>}
      </div>

      <div className="flex shrink-0 flex-col gap-1 border-t border-gray-700 p-2">
        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {pendingAttachments.map(a => (
              <span
                key={a.filename}
                className="flex items-center gap-1 rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-200"
              >
                📎 {a.filename}
                <button
                  className="text-gray-400 hover:text-white"
                  title="Remove"
                  onClick={() => removePendingAttachment(a.filename)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            multiple
            className="hidden"
            onChange={e => handleFilesSelected(e.target.files)}
          />
          <button
            className="shrink-0 rounded border border-gray-600 px-2 py-1 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50"
            disabled={loading}
            title="Attach a lab report (PDF)"
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </button>
          <textarea
            className="max-h-32 flex-1 resize-none rounded border border-gray-600 bg-black px-2 py-1 text-sm text-white placeholder:text-gray-500 outline-none focus:border-blue-500"
            style={{ color: '#fff', caretColor: '#fff' }}
            rows={1}
            placeholder="Message the assistant…"
            value={input}
            disabled={loading}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <button
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
            disabled={loading || (!input.trim() && pendingAttachments.length === 0)}
            onClick={handleSend}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

export default ChatPanel;
