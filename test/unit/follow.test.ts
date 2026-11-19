import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OLD_BRIDGE, OLD_EXTENSION, bridgeDown, failed, unanswered, versionMismatch } from '../../extension/src/bridge-client.ts';
import type { OwnFailure } from '../../extension/src/bridge-client.ts';
import {
  ARRIVE_MS, FOLLOW_EVERY_MS, FOLLOW_FIRST_MS, FOLLOW_FOR_MS, follow, sendFailed, sendOff, settled, shows, stillArriving,
} from '../../extension/src/follow.ts';
import type { Followed, FollowedState, SendReply } from '../../extension/src/messages.ts';
import { WAIT_SENTENCE } from '../../shared/types.ts';
import type { AgentInfo, BridgeError, ErrorKind, SendStatus } from '../../shared/types.ts';

const AGENT: AgentInfo = { id: 'a1b2c3d4e5f6', folder: 'site', about: 'checkout form', harness: 'codex', number: null, waiting: false };
const LABEL = 'site · checkout form · codex';
const LINE = 'Browser annotations (1) on http://localhost:5173/: read /state/sends/2026-11-18T10-00-00/annotations.md';
// The line is set in a fixed-width font; the sentence of NO_ANSWER in the bar's own.
const COPY_LINE = { text: LINE, button: 'Copy line', code: true };
const STAYS = ' The list has changed since, so it stays.';
const NO_ANSWER = {
  text: 'Clicknote did not answer this send. Say this to your coding agent; this line then says whether the send arrived.',
  tone: 'problem',
  offer: { text: WAIT_SENTENCE, button: 'Copy sentence' },
};
const REFUSED: OwnFailure = { ...failed('The bridge refused this extension.'), own: 'refused' };
const from = (kind: ErrorKind, message = ''): BridgeError => ({ ok: false, kind, message });
const followed = (state: FollowedState, line: string | null = LINE, kept = false): Followed => ({ ok: true, state, line, kept });
const SENDING = followed('sending', null);

test('the times are the ones the bar follows a send by', () => {
  assert.equal(FOLLOW_FIRST_MS, 300);
  assert.equal(FOLLOW_EVERY_MS, 2_000);
  assert.equal(FOLLOW_FOR_MS, 30_000);
  assert.equal(ARRIVE_MS, 10_000);
});

test('shows a send that is still arriving as Sending…, quiet, without an offer', () => {
  for (const count of [1, 3]) {
    for (const arrived of [false, true]) {
      assert.deepEqual(shows(SENDING, AGENT, count, arrived), { text: 'Sending…', tone: 'quiet' });
    }
  }
});

test('a send may still be arriving until it was started more than ten seconds ago', () => {
  const startedAt = 1_000_000;
  assert.equal(stillArriving(startedAt, startedAt), true);
  assert.equal(stillArriving(startedAt, startedAt + ARRIVE_MS), true);
  assert.equal(stillArriving(startedAt, startedAt + ARRIVE_MS + 1), false);
  assert.equal(stillArriving(startedAt, startedAt + 60_000), false);
});

// As after the clock was set back.
test('a send whose start lies in the future is not still arriving', () => {
  const startedAt = 1_000_000;
  assert.equal(stillArriving(startedAt, startedAt - 1), false);
  assert.equal(stillArriving(startedAt, startedAt - 60_000), false);
});

test('shows gives each row of the table, for one annotation and for three, with and without kept', () => {
  for (const [count, sent, them] of [[1, '1 annotation', 'it'], [3, '3 annotations', 'them']] as const) {
    for (const kept of [false, true]) {
      const end = kept ? STAYS : '';
      const shown = (state: SendStatus, line: string | null, arrived: boolean) =>
        shows(followed(state, line, kept), AGENT, count, arrived);
      assert.deepEqual(shown('queued', LINE, false), {
        text: `Sent ${sent} to ${LABEL}. Queued: the agent gets ${them} when it next waits.${end}`,
        tone: 'quiet',
        offer: COPY_LINE,
      });
      assert.deepEqual(shown('picked_up', LINE, true), {
        text: `Sent ${sent} to ${LABEL}. The agent picked ${them} up.${end}`,
        tone: 'done',
      });
      assert.deepEqual(shown('agent_gone', LINE, true), {
        text: `Sent ${sent} to ${LABEL}, but that agent is no longer listed and did not pick ${them} up. `
          + `Copy the line and paste it into another agent. If that agent comes back and waits again, it still gets ${them}.${end}`,
        tone: 'problem',
        offer: COPY_LINE,
      });
      const forgotten = `Sent ${sent} to ${LABEL}. Clicknote no longer knows whether the agent picked ${them} up.${end}`;
      assert.deepEqual(shown('unknown', LINE, true), { text: forgotten, tone: 'problem', offer: COPY_LINE });
      assert.deepEqual(shown('unknown', null, true), { text: forgotten, tone: 'problem' });
      assert.deepEqual(shown('unknown', null, false), { text: `This send did not arrive. Send again.${end}`, tone: 'problem' });
    }
  }
});

test('shows names the agent by its label', () => {
  assert.equal(shows(followed('picked_up'), { ...AGENT, about: '', number: 2, waiting: true }, 2, true).text,
    'Sent 2 annotations to site · codex · 2. The agent picked them up.');
});

test('sendFailed gives the rows for no answer, a bridge that is down, versions that do not fit, an agent that is gone, and any other failure', () => {
  for (const noAnswer of [
    unanswered('The bridge did not answer within 25 seconds.'),
    unanswered('The bridge gave an answer that could not be read.'),
    unanswered('Extension context invalidated.'),
    bridgeDown('Failed to fetch'),
    from('bridge_down'),
  ]) {
    assert.deepEqual(sendFailed(noAnswer), NO_ANSWER, noAnswer.message);
  }
  assert.deepEqual(sendFailed(versionMismatch(0)), { text: OLD_BRIDGE, tone: 'problem' });
  assert.deepEqual(sendFailed(versionMismatch(3)), { text: OLD_EXTENSION, tone: 'problem' });
  const theirs = 'The extension speaks protocol 1 and the bridge protocol 2.';
  assert.deepEqual(sendFailed(from('version_mismatch', theirs)), { text: theirs, tone: 'problem' });
  assert.deepEqual(sendFailed(from('agent_gone', `The agent ${AGENT.id} is no longer listed.`)),
    { text: 'That agent is no longer listed. Choose another.', tone: 'problem' });
  assert.deepEqual(sendFailed(failed('The state folder cannot be written.')),
    { text: 'Sending failed: The state folder cannot be written.', tone: 'problem' });
  assert.deepEqual(sendFailed(REFUSED), { text: 'Sending failed: The bridge refused this extension.', tone: 'problem' });
});

test('settled is true for picked_up and unknown, false for queued and sending', () => {
  assert.equal(settled('picked_up'), true);
  assert.equal(settled('unknown'), true);
  assert.equal(settled('queued'), false);
  assert.equal(settled('sending'), false);
});

test('with the bridge down, sendOff gives the sentence to say to an agent, with its button', () => {
  assert.deepEqual(sendOff(from('bridge_down')), {
    text: 'No agent is listening. Say this to your coding agent, then choose it here. Copy still works, without screenshots.',
    offer: { text: 'Wait for my annotations with the clicknote skill.', button: 'Copy sentence' },
  });
  assert.deepEqual(sendOff(from('version_mismatch', OLD_BRIDGE)), { text: OLD_BRIDGE });
  assert.equal(sendOff(from('failed', 'x')), null);
  assert.equal(sendOff(from('agent_gone', 'x')), null);
});

// A bridge that answers from a list, the last answer again once the list is used up, and a clock
// that only the sleeps move.
function asking(replies: SendReply[], clock: { now: number }) {
  const asked: number[] = [];          // the time of each ask
  const shown: SendReply[] = [];
  return {
    asked,
    shown,
    ask: async (): Promise<SendReply> => {
      asked.push(clock.now);
      return replies[Math.min(asked.length - 1, replies.length - 1)];
    },
    show: (reply: SendReply) => { shown.push(reply); },
    sleep: async (ms: number) => { clock.now += ms; },
    now: () => clock.now,
  };
}

test('follow asks every two seconds and stops at a settled state', async () => {
  const clock = { now: 1_000_000 };
  const bridge = asking([followed('queued'), followed('queued'), followed('picked_up')], clock);
  const last = await follow({ ...bridge, from: clock.now, signal: new AbortController().signal });
  assert.deepEqual(bridge.asked, [1_000_000, 1_002_000, 1_004_000]);
  assert.deepEqual(bridge.shown, [followed('queued'), followed('queued'), followed('picked_up')]);
  assert.deepEqual(last, followed('picked_up'));
});

test('follow stops at a send the bridge does not know', async () => {
  const clock = { now: 0 };
  const bridge = asking([followed('queued'), followed('unknown')], clock);
  assert.deepEqual(await follow({ ...bridge, from: 0, signal: new AbortController().signal }), followed('unknown'));
  assert.deepEqual(bridge.asked, [0, 2_000]);
});

// The bar says once that the agent is gone, and forgets the send: a picked_up that the bridge
// would give later, after the agent came back, is never asked for.
test('a send whose agent is gone is settled', async () => {
  assert.equal(settled('agent_gone'), true);
  const clock = { now: 0 };
  const bridge = asking([followed('queued'), followed('agent_gone'), followed('picked_up')], clock);
  assert.deepEqual(await follow({ ...bridge, from: 0, signal: new AbortController().signal }), followed('agent_gone'));
  assert.deepEqual(bridge.asked, [0, 2_000]);
  assert.deepEqual(bridge.shown, [followed('queued'), followed('agent_gone')]);
});

test('follow waits before its first ask when told to, and counts the thirty seconds from the start', async () => {
  const clock = { now: 1_000_000 };
  const bridge = asking([followed('queued'), followed('picked_up')], clock);
  const last = await follow({ ...bridge, delay: FOLLOW_FIRST_MS, from: clock.now, signal: new AbortController().signal });
  assert.deepEqual(bridge.asked, [1_000_300, 1_002_300]);
  assert.deepEqual(last, followed('picked_up'));
  const start = { now: 0 };
  const queued = asking([followed('queued')], start);
  await follow({ ...queued, delay: FOLLOW_FIRST_MS, from: 0, signal: new AbortController().signal });
  assert.deepEqual([queued.asked[0], queued.asked[1], queued.asked.at(-1), queued.asked.length], [300, 2_300, 30_300, 16]);
});

test('follow that is ended while it waits for its first ask asks nothing', async () => {
  const clock = { now: 0 };
  const stop = new AbortController();
  const bridge = asking([followed('queued')], clock);
  const last = await follow({
    ...bridge, sleep: async ms => { clock.now += ms; stop.abort(); }, delay: FOLLOW_FIRST_MS, from: 0, signal: stop.signal,
  });
  assert.equal(last, null);
  assert.deepEqual([bridge.asked, bridge.shown], [[], []]);
});

test('follow stops after thirty seconds of queued', async () => {
  const clock = { now: 5_000 };
  const bridge = asking([followed('queued')], clock);
  const last = await follow({ ...bridge, from: clock.now, signal: new AbortController().signal });
  assert.ok(bridge.asked.length <= 16, `${bridge.asked.length} asks`);
  assert.equal(bridge.asked.length, 16);
  assert.equal(bridge.asked.at(-1), 35_000);
  assert.equal(bridge.shown.length, 16);
  assert.deepEqual(last, followed('queued'));
});

test('follow goes on asking after sending and stops at the state that follows it', async () => {
  for (const state of ['queued', 'picked_up', 'unknown'] as const) {
    const clock = { now: 0 };
    const bridge = asking([SENDING, SENDING, followed(state)], clock);
    // A single ask, as when the user comes back: queued would end it, sending does not.
    const last = await follow({ ...bridge, from: -Infinity, signal: new AbortController().signal });
    assert.deepEqual(bridge.asked, [0, 2_000, 4_000], state);
    assert.deepEqual(bridge.shown, [SENDING, SENDING, followed(state)], state);
    assert.deepEqual(last, followed(state), state);
  }
});

test('follow asks once for a send that is older than thirty seconds', async () => {
  const clock = { now: 100_000 };
  const bridge = asking([followed('queued')], clock);
  assert.deepEqual(await follow({ ...bridge, from: 60_000, signal: new AbortController().signal }), followed('queued'));
  assert.deepEqual(bridge.asked, [100_000]);
});

test('follow stops at a failure and gives it', async () => {
  const clock = { now: 0 };
  const down = bridgeDown('Failed to fetch');
  const bridge = asking([followed('queued'), down, followed('picked_up')], clock);
  assert.deepEqual(await follow({ ...bridge, from: 0, signal: new AbortController().signal }), down);
  assert.equal(bridge.asked.length, 2);
  assert.deepEqual(bridge.shown, [followed('queued'), down]);
});

test('follow stops when its signal ends, without another ask', async () => {
  const clock = { now: 0 };
  const during = new AbortController();
  const sleeping = asking([followed('queued')], clock);
  const last = await follow({
    ...sleeping,
    sleep: async ms => { clock.now += ms; during.abort(); },
    from: 0,
    signal: during.signal,
  });
  assert.deepEqual(last, followed('queued'));
  assert.equal(sleeping.asked.length, 1);
  assert.equal(sleeping.shown.length, 1);
  // Ended while an ask is under way: its answer is not shown.
  const meanwhile = new AbortController();
  const asked = asking([followed('picked_up')], clock);
  await follow({
    ...asked,
    ask: async () => {
      meanwhile.abort();
      return asked.ask();
    },
    from: 0,
    signal: meanwhile.signal,
  });
  assert.equal(asked.asked.length, 1);
  assert.deepEqual(asked.shown, []);
});
