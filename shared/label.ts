import type { AgentInfo } from './types.ts';

// How an agent is named to the user, by the bridge's commands and by the bar. Nothing of Node
// and nothing of the browser is used here, so both sides build it in.

// The agent's label: its folder, what it works on, its harness and its number, joined by ` · `,
// without the parts that are empty.
export function agentLabel(agent: Pick<AgentInfo, 'folder' | 'about' | 'harness' | 'number'>): string {
  const number = agent.number === null ? '' : String(agent.number);
  return [agent.folder, agent.about, agent.harness, number].filter(part => part !== '').join(' · ');
}

// The agent as the dropdown lists it: a full dot, the label and `waiting` for an agent that
// waits; an open dot and the label for one that does not.
export function listedAs(agent: Pick<AgentInfo, 'folder' | 'about' | 'harness' | 'number' | 'waiting'>): string {
  return agent.waiting ? `● ${agentLabel(agent)} · waiting` : `○ ${agentLabel(agent)}`;
}
