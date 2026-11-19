import { BRIDGE_HOST } from '../../shared/types.ts';
import { parseUrl } from '../../shared/url.ts';

// The agent of each tab: the agent whose link opened the tab, or the agent the tab last sent to.
// It lives in chrome.storage.session under `agent:<tabId>`, next to the tab's draft, so it is
// gone when the browser starts and when the extension is reloaded; the agent of the page's site
// then decides. Chrome APIs are used inside the functions only, so chooseAgent and isOpenAddress
// load in Node.

const agentKey = (tabId: number) => `agent:${tabId}`;

// The id of the tab's agent, or null when the tab has none.
export async function readTabAgent(tabId: number): Promise<string | null> {
  const key = agentKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key];
  return typeof stored === 'string' ? stored : null;
}

// Makes the agent with this id the tab's agent, in place of any earlier one.
export async function saveTabAgent(tabId: number, id: string): Promise<void> {
  await chrome.storage.session.set({ [agentKey(tabId)]: id });
}

// Leaves the tab without an agent of its own.
export async function forgetTabAgent(tabId: number): Promise<void> {
  await chrome.storage.session.remove(agentKey(tabId));
}

// The agent the bar is to choose, from the ids of the agents listed: the tab's agent when it is
// listed, else the one the bridge chose (the agent of the page's site, or none). `forget` is true
// when the tab has an agent that is not listed, as when it has gone.
export function chooseAgent(
  tabAgent: string | null, listed: string[], fromBridge: string | null,
): { preselect: string | null; forget: boolean } {
  if (tabAgent !== null && listed.includes(tabAgent)) return { preselect: tabAgent, forget: false };
  return { preselect: fromBridge, forget: tabAgent !== null };
}

// Whether `url` is the open address of the link with this code, on the bridge's port: the origin
// http://127.0.0.1:<port> and the path /open/<code>, whatever the query or the hash. The manifest
// runs the content script on that port only; this does not rely on it.
export function isOpenAddress(url: string | undefined, code: string, port: number): boolean {
  const parsed = parseUrl(url ?? '');
  return parsed?.origin === `http://${BRIDGE_HOST}:${port}` && parsed.pathname === `/open/${code}`;
}
