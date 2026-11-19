import { claim, makeInbox, type Queued, waitForSend } from './inbox.ts';
import { startBeacon } from './presence.ts';
import { seeBridge, type BridgeSeen } from './record.ts';
import { leaveAgent, seenAgent } from './registry.ts';

// The wait for an agent's next sends, which the wait command runs.

// How often a wait renews the agent's sign of life, by default.
const BEAT_MS = 240_000;
// The pause of a wait after a claim that gave nothing, before it looks again.
const CLAIM_AGAIN_MS = 20;

// What a wait uses: a way to make sure a bridge runs, the signal that ends the wait, how often it
// looks for a send (default that of waitForSend), how often it renews the agent's sign of life
// (default BEAT_MS), and what it does as well at each such beat.
export interface NextDeps {
  ensure: () => Promise<BridgeSeen>;
  signal: AbortSignal;
  pollMs?: number;
  beatMs?: number;
  onBeat: () => void;
}

// Waits until a send is queued for the agent, claims every send it can hand out, and resolves with
// them, oldest first; with none when the signal ends the wait. The caller confirms the sends or
// gives them back. The agent's inbox folder is made first, so the first send to a new agent is
// noticed as soon as it is queued, and the agent has a wait beacon for as long as the wait runs,
// so the bar lists it as waiting. Every beatMs the agent gets a sign of life, onBeat is called,
// and when the bridge is down then, it makes sure one runs again. A wait that ends with sends, or
// on a claim that fails, gives the agent one more sign of life, so the hour it stays listed counts
// from the end of the wait. A wait that the signal ends gives none, and marks the agent as left in
// its place, so the bar lists it no longer once no wait of it is open. Either way the beacon stops
// after that, so a stopped wait takes the agent from waiting straight off the list. A claim that
// fails throws its error after the same.
export async function nextSends(agent: string, deps: NextDeps): Promise<Queued[]> {
  try {
    makeInbox(agent);
  } catch {
    // The look every pollMs stands in for the watch.
  }
  const beacon = startBeacon('wait', agent);
  let ensuring = false;
  const timer = setInterval(() => {
    renew(agent);
    deps.onBeat();
    if (ensuring || seeBridge().state !== 'down') return;
    ensuring = true;
    void deps.ensure().catch(() => undefined).finally(() => { ensuring = false; });
  }, deps.beatMs ?? BEAT_MS);
  let stopped = false;
  try {
    while (await waitForSend(agent, deps.signal, deps.pollMs)) {
      const sends = claim(agent);
      if (sends.length > 0) return sends;
      // A claim gives nothing while another process holds the agent's lock, and waitForSend then
      // ends at once, so the timers and the signal run in this pause before it looks again.
      await pause(CLAIM_AGAIN_MS, deps.signal);
    }
    stopped = true;
    return [];
  } finally {
    clearInterval(timer);
    if (stopped) leave(agent);
    else renew(agent);
    beacon.stop();
  }
}

// A sign of life of the agent while or as it waits. One that cannot be written is passed over:
// the wait's own outcome is the one to give, and the next sign of life may be written.
function renew(id: string): void {
  try {
    seenAgent(id);
  } catch {
    // The agent keeps its last sign of life.
  }
}

// Marks the agent as left as its wait is stopped. A mark that cannot be written is passed over:
// the agent then stays listed for the hour after its last sign of life.
function leave(id: string): void {
  try {
    leaveAgent(id);
  } catch {
    // The agent stays as its record has it.
  }
}

// Resolves after `ms`, or at once when the signal ends or has ended. Either way the timer and the
// listener on the signal are gone then.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
