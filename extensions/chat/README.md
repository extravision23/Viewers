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
  "message": "<user text>"   // "" or null on the first call → runs the first step
}

200 OK
{
  "reply": "<assistant text>",
  "threadId": "<echoed / assigned>",
  "done": false
}
```

This matches the LangGraph interrupt/resume model used by the agent
(`graphs/ich_graph.py`): the **first** call (no checkpoint for `threadId`, or an
empty `message`) invokes the graph with `{ study_id }` and streams to the first
interrupt; **subsequent** calls resume the graph with the user's message
(`Command(resume=message)`). Graph state lives in the agent's checkpointer keyed
by `threadId`.

> The HTTP wrapper (`AgentFunction`) that exposes this endpoint lives in the
> `XV_ai_assistant` repo and must be deployed for the panel to function
> end-to-end. The terminal runner (`main.py`) implements the same flow.
