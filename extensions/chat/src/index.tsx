import { id } from './id';
import getPanelModule from './getPanelModule';

/**
 * ExtraVision AI assistant chat extension.
 *
 * Exposes a single study-level side panel that talks to the agent backend
 * (LangGraph ICH agent). The panel auto-runs the agent's first step on open
 * using the current study as context — see ChatPanel / agentClient.
 */
const chatExtension = {
  id,
  getPanelModule,
};

export default chatExtension;
