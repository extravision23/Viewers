# @extravision/extension-chat

Study-level AI assistant chat panel for OHIF. Talks to the ExtraVision agent
backend (the LangGraph ICH agent in `XV_ai_assistant`).

## Behaviour

- One right-side panel, **scoped to the current study** (StudyInstanceUID read
  from the viewer URL).
- On open it **auto-runs the agent's first step** with the study as context
  (no user message needed) — the agent lists the study's series and asks which
  to analyze.
- Chat history + thread id are persisted in `localStorage` per study
  (`xv-ai-chat:<StudyInstanceUID>`), so the conversation survives reopens.
- A 📎 button next to the input lets the clinician attach PDF documents (e.g.
  a Ukrainian lab-report printout) to a message, the same way Claude/ChatGPT
  attach files to chat — the agent parses the PDF and folds the extracted
  values into the conversation. Only the filename is persisted to
  `localStorage`, never the file bytes.

## Wiring (already done)

- Registered in `platform/app/pluginConfig.json`.
- Added to the **segmentation** mode (`modes/segmentation/src/index.tsx`) as the
  first right panel: id `@extravision/extension-chat.panelModule.aiChat`.

Because this is a new workspace package, run `bun install` (or `yarn install`)
once so the workspace symlink is created; the dev/prod build then regenerates
`platform/app/src/pluginImports.js` automatically from `pluginConfig.json`.

## Backend contract

The panel POSTs to `{agentBaseUrl}/agent`, where `agentBaseUrl` is read from
`window.config.agentBaseUrl`, falling back to `window.config.pythonFunctionsBaseUrl`,
then `http://localhost:7071/api`.

```
POST {agentBaseUrl}/agent
{
  "agentType": "ich",
  "studyInstanceUID": "<uid>",
  "threadId": "<stable per study+session>",
  "message": "<user text>",   // "" or null on the first call → runs the first step
  "attachments": [            // optional, PDF-only, e.g. an uploaded lab report
    { "filename": "labs.pdf", "contentType": "application/pdf", "dataBase64": "<base64>" }
  ]
}

200 OK
{
  "reply": "<assistant text>",
  "threadId": "<echoed / assigned>",
  "done": false
}
```

`attachments` are dropped on the very first call for a thread (the graph
ignores `message` there too — it starts by asking which series to analyze);
send them with a later message once the conversation is under way. Each PDF
is parsed to text server-side and appended to `message` before the graph
sees it, so no special client-side handling of the reply is needed — the
agent just "reads" the values like it would a typed-out lab result.

This matches the LangGraph interrupt/resume model used by the agent
(`graphs/ich_graph.py`): the **first** call (no checkpoint for `threadId`, or an
empty `message`) invokes the graph with `{ study_id }` and streams to the first
interrupt; **subsequent** calls resume the graph with the user's message
(`Command(resume=message)`). Graph state lives in the agent's checkpointer keyed
by `threadId`.

> The HTTP wrapper (`AgentFunction`) that exposes this endpoint lives in the
> `XV_ai_assistant` repo and must be deployed for the panel to function
> end-to-end. The terminal runner (`main.py`) implements the same flow.
