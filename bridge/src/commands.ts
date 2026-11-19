import { agentLabel } from '../../shared/label.ts';
import { BRIDGE_HOST } from '../../shared/types.ts';
import { isLinkable } from '../../shared/url.ts';
import { confirm, release } from './inbox.ts';
import { writeLink } from './links.ts';
import { requestStop, seeBridge, type BridgeSeen } from './record.ts';
import { listAgents, readAgent, registerAgent, seenAgent, type Agent } from './registry.ts';
import { nextSends } from './waiting.ts';

// The commands an agent runs: register, open, wait and stop. They never talk to the bridge over
// its port; they work through the files in the state folder, which the bridge reads too.

// What a command uses: the folder it runs in, the bridge's port for the open address, a way to
// make sure a bridge runs that says what it found, the opener of an open address (false when it
// could not open it), and a line on standard output (`out`) and on the error stream (`note`).
export interface CommandDeps {
  cwd: string;
  port: number;
  ensure: () => Promise<BridgeSeen>;
  open: (address: string) => boolean;
  out: (line: string) => void;
  note: (line: string) => void;
}

// What a wait uses over that: the signal that ends it, how it writes the line of a send on
// standard output (`write`, which resolves once the line is written and rejects when it cannot
// be), how often it says that it still waits (default that of nextSends' beat), and how often it
// looks for a send (default that of waitForSend).
export interface WaitDeps extends CommandDeps {
  signal: AbortSignal;
  write: (line: string) => Promise<void>;
  noteMs?: number;
  pollMs?: number;
}

// Why no bridge of this version runs: one of another version runs, the port is held by another
// program, or the bridge did not start for another reason.
export const NOT_RUNNING_REASONS: { other: string; port_in_use: string; down: string } = {
  other: 'the running Clicknote is another version than this command. Run stop, then run this again.',
  port_in_use: 'port 47823 is held by another program, so Clicknote cannot start.',
  down: 'Clicknote did not start.',
};

// How long stop looks for the bridge to be gone, and the pause between two looks.
const STOP_WAIT_MS = 5_000;
const STOP_LOOK_MS = 100;

const LINKABLE_HINT = 'give the full URL, starting with http://, https:// or file://, with a space written as %20.';

// Registers a new agent for the folder the command runs in, and prints its id and its label.
// A bridge that is down is noted, and the agent registered all the same; with a bridge of
// another version nothing is written, and it gives 1.
export async function runRegister(input: { harness: string; about: string }, deps: CommandDeps): Promise<number> {
  const seen = await deps.ensure();
  if (seen.state !== 'running') {
    deps.note(`Clicknote is not running: ${notRunningReason(seen)}`);
    if (seen.state === 'other') return 1;
  }
  const agent = registerAgent({ harness: input.harness, about: input.about, folder: deps.cwd });
  printAgent(agent, deps);
  return 0;
}

// Links the page to the agent and opens the page's open address in the browser, or prints that
// address when `addressOnly` is set or the browser could not be started. The agent is the one
// given, which gets a sign of life, else a new one. A problem of the tool never keeps the page
// from opening: when no bridge of this version runs, or making sure of the bridge, registering or
// renewing the agent, or writing the link fails, it prints the URL as given, says why it did not
// link, and gives 0 all the same, so the agent opens the page itself; the lines it printed before
// stay. With a bridge of another version it writes nothing. A URL that cannot be linked is refused
// first, with 1, before a bridge is made sure of and before anything is written, so a mistyped
// URL starts nothing. An agent that is not known gives 1 too, also after a failure. Neither prints
// anything on standard output.
export async function runOpen(
  input: { url: string; agent?: string; harness?: string; about?: string; addressOnly: boolean },
  deps: CommandDeps,
): Promise<number> {
  if (!linkable(input.url, deps)) return 1;
  let code: string;
  try {
    const seen = await deps.ensure();
    if (seen.state === 'other') return notLinked(input.url, notRunningReason(seen), deps);
    const agent = input.agent === undefined
      ? registerAgent({ harness: input.harness ?? '', about: input.about ?? '', folder: deps.cwd })
      : seenAgent(input.agent, input.about);
    if (!agent) return unknownAgent(input.agent ?? '', deps);
    const label = printAgent(agent, deps);
    if (seen.state === 'down') return notLinked(input.url, notRunningReason(seen), deps);
    code = writeLink({ url: input.url, agent: agent.id, label });
  } catch (error) {
    // A failure that came before the agent was looked up does not hide that it is not known.
    if (input.agent !== undefined && readAgent(input.agent) === null) return unknownAgent(input.agent, deps);
    return notLinked(input.url, errorMessage(error), deps);
  }
  const address = `http://${BRIDGE_HOST}:${deps.port}/open/${code}`;
  if (input.addressOnly) {
    deps.out(`open this address: ${address}`);
    return 0;
  }
  if (deps.open(address)) {
    deps.out(`opened: ${input.url}`);
    return 0;
  }
  deps.out(`open this address: ${address}`);
  deps.note('Clicknote could not start the browser.');
  return 0;
}

// Waits until a send is queued for the agent (see nextSends), writes the line of each send it
// hands out, oldest first, each once the one before it is written, only then confirms the sends,
// and gives 0. The agent gets a sign of life, with `about` when given, and is listed as waiting
// while the wait runs. Every noteMs it says that it still waits, which is a sign of life of the
// agent too. The signal ends it with 1: the agent has then left the list until its next sign of
// life, unless another wait of it is open (see nextSends), and the wait says so. Sends it handed
// out before the signal came are still written and confirmed. When a line cannot be written, none
// of the sends is confirmed; when a line cannot be written or the sends cannot be confirmed, the
// sends that are still claimed are given back at once for the next wait, and the error thrown on;
// a send confirmed already stays picked up. A bridge that is down is noted once, at the start, and
// the wait goes on; with a bridge of another version nothing is written, and it gives 1, as it
// does for an agent that is not known.
export async function runWait(input: { agent: string; about?: string }, deps: WaitDeps): Promise<number> {
  const seen = await deps.ensure();
  if (seen.state === 'other') {
    deps.note(`Clicknote is not running: ${notRunningReason(seen)}`);
    return 1;
  }
  const agent = seenAgent(input.agent, input.about);
  if (!agent) return unknownAgent(input.agent, deps);
  if (seen.state === 'down') deps.note(`Clicknote is not running: ${notRunningReason(seen)}`);
  const sends = await nextSends(agent.id, {
    ensure: deps.ensure,
    signal: deps.signal,
    pollMs: deps.pollMs,
    beatMs: deps.noteMs,
    onBeat: () => deps.note('Still waiting for annotations.'),
  });
  if (sends.length === 0) {
    deps.note('Stopped waiting. You are off the list in the bar until you wait again.');
    return 1;
  }
  const ids = sends.map(queued => queued.send);
  try {
    for (const queued of sends) await deps.write(queued.line);
    confirm(agent.id, ids);
  } catch (error) {
    try {
      release(agent.id, ids);
    } catch {
      // The error of the line or of the confirmation is the one to give; a claim also runs out on
      // its own.
    }
    throw error;
  }
  return 0;
}

// Asks the bridge that lives, of this version or another, to stop, and looks every STOP_LOOK_MS
// until it is gone, for STOP_WAIT_MS. Gives 0 when it is gone, or was not running; 1 when it
// still lives after that.
export async function runStop(deps: {
  note: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number;
}): Promise<number> {
  if (seeBridge().state === 'down') {
    deps.note('Clicknote was not running.');
    return 0;
  }
  requestStop();
  const until = deps.now() + STOP_WAIT_MS;
  while (deps.now() < until) {
    await deps.sleep(STOP_LOOK_MS);
    if (seeBridge().state === 'down') {
      deps.note('Clicknote stopped.');
      return 0;
    }
  }
  deps.note('Clicknote did not stop within 5 seconds.');
  return 1;
}

// The reason for a bridge that is not running, of this version, as a command gives it.
function notRunningReason(seen: Exclude<BridgeSeen, { state: 'running' }>): string {
  if (seen.state === 'other') return NOT_RUNNING_REASONS.other;
  return seen.problem === 'port_in_use' ? NOT_RUNNING_REASONS.port_in_use : NOT_RUNNING_REASONS.down;
}

// Prints the agent's id and its label, and gives the label.
function printAgent(agent: Agent, deps: CommandDeps): string {
  const label = labelOf(agent);
  deps.out(`agent: ${agent.id}`);
  deps.out(`listed as: ${label}`);
  return label;
}

// The agent's label as the bar lists it, with its number; from its record, without a number, when
// it is not listed.
function labelOf(agent: Agent): string {
  const listed = listAgents().find(entry => entry.id === agent.id);
  return agentLabel(listed ?? { folder: agent.folder, about: agent.about, harness: agent.harness, number: null });
}

// What open does when the state folder cannot be used, for the reason given: a URL that cannot be
// linked is refused with 1, as runOpen refuses it; any other URL is printed as given, with why it
// was not linked, and gives 0.
export function runOpenUnlinked(url: string, reason: string, deps: Pick<CommandDeps, 'out' | 'note'>): number {
  if (!linkable(url, deps)) return 1;
  return notLinked(url, reason, deps);
}

// Whether the URL can be linked; when it cannot, says so.
function linkable(url: string, deps: Pick<CommandDeps, 'note'>): boolean {
  if (isLinkable(url)) return true;
  deps.note(`Cannot open ${JSON.stringify(url)}: ${LINKABLE_HINT}`);
  return false;
}

// Prints the URL as given for the agent to open, says why it was not linked, and gives 0.
function notLinked(url: string, reason: string, deps: Pick<CommandDeps, 'out' | 'note'>): number {
  deps.out(`open this address: ${url}`);
  deps.note(`Not linked: ${reason}`);
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Says that the agent is not known, and gives 1.
function unknownAgent(id: string, deps: CommandDeps): number {
  deps.note(`Unknown agent ${id}. Register again.`);
  return 1;
}
