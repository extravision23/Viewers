export interface AgentResponse {
  reply: string;
  threadId: string;
  done: boolean;
}

function getAgentBaseUrl(): string {
  const cfg = (window as any).config || {};
  return cfg.agentBaseUrl || 'http://localhost:7072';
}

export async function sendAgentMessage(params: {
  studyInstanceUID: string;
  threadId: string;
  message: string | null;
}): Promise<AgentResponse> {
  const { studyInstanceUID, threadId, message } = params;

  const resp = await fetch(`${getAgentBaseUrl()}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentType: 'ich',
      studyInstanceUID,
      threadId,
      message: message ?? '',
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
  };
}
