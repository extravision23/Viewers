export interface AgentFormField {
  key: string;
  label: string;
  hint: string;
}

export interface AgentForm {
  title: string;
  fields: AgentFormField[];
}

export interface AgentResponse {
  reply: string;
  threadId: string;
  done: boolean;
  form?: AgentForm;
}

// PDF-only for now (e.g. a lab report) — see agent_server.py's _decode_attachments.
export interface AgentAttachment {
  filename: string;
  contentType: string;
  dataBase64: string;
}

function getAgentBaseUrl(): string {
  const cfg = (window as any).config || {};
  return cfg.agentBaseUrl || 'http://localhost:7072';
}

export async function sendAgentMessage(params: {
  studyInstanceUID: string;
  threadId: string;
  message: string | null;
  attachments?: AgentAttachment[];
}): Promise<AgentResponse> {
  const { studyInstanceUID, threadId, message, attachments } = params;

  const resp = await fetch(`${getAgentBaseUrl()}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentType: 'ich',
      studyInstanceUID,
      threadId,
      message: message ?? '',
      ...(attachments && attachments.length ? { attachments } : {}),
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Agent request failed (${resp.status}): ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  return {
    reply: data.reply ?? '',
    threadId: data.threadId ?? threadId,
    done: Boolean(data.done),
    form: data.form ?? undefined,
  };
}
