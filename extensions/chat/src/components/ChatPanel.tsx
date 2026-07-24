import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sendAgentMessage } from '../api/agentClient';
import type { AgentForm as AgentFormData } from '../api/agentClient';
import Markdown from './Markdown';

type Role = 'user' | 'assistant';
interface ChatMessage {
  role: Role;
  content: string;
  form?: AgentFormData;
}
interface PersistedState {
  threadId: string;
  messages: ChatMessage[];
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
          <input
            className="rounded border border-gray-600 bg-black px-2 py-1 text-xs text-white placeholder:text-gray-500 outline-none focus:border-blue-500"
            style={{ color: '#fff', caretColor: '#fff' }}
            placeholder={f.hint}
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

  const threadIdRef = useRef<string>('');
  const initStartedRef = useRef<string | null>(null); // study for which init was kicked off
  const scrollRef = useRef<HTMLDivElement>(null);

  // One round-trip to the agent; appends the reply (plus its form, if any) and persists.
  const runTurn = useCallback(
    async (message: string | null, baseMessages: ChatMessage[]) => {
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
        });
        threadIdRef.current = res.threadId;
        const next = [...baseMessages, { role: 'assistant' as Role, content: res.reply, form: res.form }];
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
    if (!text || loading) {
      return;
    }
    const next = [...messages, { role: 'user' as Role, content: text }];
    setMessages(next);
    setInput('');
    runTurn(text, next);
  }, [input, loading, messages, runTurn]);

  // Submission from an interactive form (see AgentFormFields) — same path as
  // typing a reply, just with the composed "Label: value" lines as the text.
  const handleFormSubmit = useCallback(
    (text: string) => {
      if (!text || loading) {
        return;
      }
      const next = [...messages, { role: 'user' as Role, content: text }];
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

  return (
    <div className="flex h-full max-h-full flex-col overflow-hidden bg-black text-gray-100">
      <div className="flex shrink-0 items-center justify-between border-b border-gray-700 px-3 py-2">
        <span className="text-sm font-semibold text-white">AI Assistant</span>
        <button
          className="rounded px-2 py-1 text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-50"
          disabled={loading}
          onClick={handleReset}
          title="Start a new conversation for this study"
        >
          Reset
        </button>
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
              {m.role === 'user' ? m.content : <Markdown text={m.content} />}
              {m.role === 'assistant' && m.form && i === messages.length - 1 && (
                <AgentFormFields form={m.form} disabled={loading} onSubmit={handleFormSubmit} />
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

      <div className="flex shrink-0 items-end gap-2 border-t border-gray-700 p-2">
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
          disabled={loading || !input.trim()}
          onClick={handleSend}
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default ChatPanel;
