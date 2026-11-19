import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  AGENT_ID, AGENT_KEEP_MS, AGENT_TTL_MS, PART_MAX, cleanPart, leaveAgent, listAgents, pruneAgents, readAgent,
  registerAgent, removeAgent, seenAgent,
} from '../../bridge/src/registry.ts';
import { STALE_MS, pruneBeacons, startBeacon } from '../../bridge/src/presence.ts';
import { agentLabel } from '../../shared/label.ts';

let dir = '';
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLICKNOTE_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'clicknote-'));
  process.env.CLICKNOTE_STATE_DIR = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLICKNOTE_STATE_DIR;
  else process.env.CLICKNOTE_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

// The .json files under the state folder, at any depth, whose name is an agent id.
function agentFiles(): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(path => /^[0-9a-f]{12}\.json$/.test(basename(path)))
    .map(path => join(dir, path));
}

const claude = { harness: 'claude-code', about: 'landing page copy', folder: '/Users/you/code/my-site' };

test('an agent registers under a new id and is listed', () => {
  const agent = registerAgent(claude, 1_000);
  assert.match(agent.id, AGENT_ID);
  assert.deepEqual(listAgents(1_000), [{ id: agent.id, folder: 'my-site', about: 'landing page copy',
    harness: 'claude-code', number: null, waiting: false }]);
});

test('the folder is the last part of the path, on every system', () => {
  assert.equal(registerAgent({ ...claude, folder: 'C:\\Users\\you\\site' }).folder, 'site');
  assert.equal(registerAgent({ ...claude, folder: '/Users/you/code/my-site/' }).folder, 'my-site');
});

test('a part is cleaned to one line and cut', () => {
  assert.equal(cleanPart('  land\u202Eing\u0007 \n page\u200B  '), 'landing page');
  assert.equal(cleanPart('x'.repeat(500)).length, PART_MAX);
  assert.equal(cleanPart('\u0000\u202E\u200B'), '');
});

test('an empty or hostile description is left out of the label', () => {
  const agent = registerAgent({ ...claude, about: '\u0000\u202E' }, 1_000);
  assert.equal(agentLabel(listAgents(1_000)[0]), 'my-site · claude-code');
  assert.equal(readAgent(agent.id)?.about, '');
});

test('of two agents that read the same, the later one gets a number', () => {
  const first = registerAgent(claude, 1_000);
  const second = registerAgent(claude, 2_000);
  const third = registerAgent(claude, 3_000);
  assert.deepEqual(listAgents(3_000).map(agent => [agent.id, agent.number]),
    [[first.id, null], [second.id, 2], [third.id, 3]]);
});

test('two agents that register in the same millisecond get two ids and both stay', () => {
  const first = registerAgent(claude, 1_000);
  const second = registerAgent(claude, 1_000);
  assert.notEqual(first.id, second.id);
  assert.equal(listAgents(1_000).length, 2);
});

test('an agent leaves the list an hour after its last sign of life and comes back with the same id', () => {
  const { id } = registerAgent(claude, 0);
  assert.equal(listAgents(AGENT_TTL_MS).length, 1);
  assert.equal(listAgents(AGENT_TTL_MS + 1).length, 0);
  assert.equal(seenAgent(id, undefined, AGENT_TTL_MS + 5)?.id, id);
  assert.equal(listAgents(AGENT_TTL_MS + 6)[0].id, id);
});

test('a sign of life can carry a new description', () => {
  const { id } = registerAgent(claude, 0);
  seenAgent(id, 'checkout form', 10);
  assert.equal(listAgents(10)[0].about, 'checkout form');
  seenAgent(id, undefined, 20);
  assert.equal(listAgents(20)[0].about, 'checkout form');
});

test('an agent that waits is listed as waiting, also after the hour', () => {
  const { id } = registerAgent(claude, 0);
  const beacon = startBeacon('wait', id);
  try {
    assert.deepEqual(listAgents(Date.now()).map(agent => agent.waiting), [true]);
  } finally {
    beacon.stop();
  }
});

// Adds the fields to the agent's record on disk.
function addToRecord(id: string, fields: object): void {
  const path = agentFiles().find(file => basename(file) === `${id}.json`)!;
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...fields }));
}

// The field is passed over, whatever its value.
test('a record with a field the program does not know is read and listed', () => {
  const agents = ['text', 7, null, { nested: true }].map(extra => {
    const agent = registerAgent(claude, 1_000);
    addToRecord(agent.id, { extra });
    assert.deepEqual(readAgent(agent.id), agent, JSON.stringify(extra));
    return agent.id;
  });
  assert.deepEqual(listAgents(1_000 + AGENT_TTL_MS).map(agent => agent.id), [...agents].sort());
  assert.deepEqual(listAgents(1_000 + AGENT_TTL_MS + 1), []);
});

// A file in the beacons folder of a kind the program does not know changes nothing in the list of
// agents; pruning removes it once it is stale, as it does any file there.
test('a beacon file of a kind the program does not know changes nothing for listing and pruning', () => {
  const now = Date.now();
  const first = registerAgent(claude, now - 2);
  const second = registerAgent({ ...claude, about: 'pricing table' }, now - 1);
  const listed = listAgents(now);
  const beacons = join(dir, 'beacons');
  mkdirSync(beacons, { mode: 0o700 });
  for (const { id } of [first, second]) writeFileSync(join(beacons, `other.${id}.${process.pid}`), '{}', { mode: 0o600 });
  assert.deepEqual(listAgents(now), listed);
  assert.deepEqual(listed.map(agent => agent.id), [first.id, second.id]);
  assert.doesNotThrow(() => pruneBeacons(now));
  assert.equal(readdirSync(beacons).length, 2);
  assert.doesNotThrow(() => pruneBeacons(now + STALE_MS + 1_000));
  assert.deepEqual(readdirSync(beacons), []);
});

// A wait that is stopped from outside marks its agent as left.
test('an agent that left is not listed', () => {
  const { id } = registerAgent(claude, 1_000);
  leaveAgent(id);
  assert.deepEqual(listAgents(1_000), []);
  assert.equal(readAgent(id)?.left, true);
  assert.equal(readAgent(id)?.seen, 1_000);
});

test('a sign of life lists an agent that left again', () => {
  const agent = registerAgent(claude, 1_000);
  leaveAgent(agent.id);
  assert.deepEqual(seenAgent(agent.id, 'more', 2_000), { ...agent, about: 'more', seen: 2_000 });
  assert.deepEqual(readAgent(agent.id), { ...agent, about: 'more', seen: 2_000 });
  assert.deepEqual(listAgents(2_000).map(listed => listed.id), [agent.id]);
});

test('an agent that left is listed while a wait of it is open', () => {
  const { id } = registerAgent(claude, Date.now());
  leaveAgent(id);
  const beacon = startBeacon('wait', id);
  try {
    assert.deepEqual(listAgents(Date.now()).map(agent => [agent.id, agent.waiting]), [[id, true]]);
  } finally {
    beacon.stop();
  }
  assert.deepEqual(listAgents(Date.now()), []);
});

test('a record with a left that is not true is not read', () => {
  for (const left of ['yes', false, null, 1]) {
    const { id } = registerAgent(claude, 1_000);
    addToRecord(id, { left });
    assert.equal(readAgent(id), null, String(left));
  }
  assert.deepEqual(listAgents(1_000), []);
});

test('leaving changes nothing for an unknown id', () => {
  leaveAgent('000000000000');
  leaveAgent('../x');
  assert.deepEqual(readdirSync(dir), []);
  const agent = registerAgent(claude, 1_000);
  leaveAgent('000000000000');
  assert.deepEqual(readAgent(agent.id), agent);
});

test('an id of another form and an id without a record are nothing', () => {
  assert.equal(readAgent('../x'), null);
  assert.equal(seenAgent('000000000000'), null);
  removeAgent('../x');
});

test('a file among the agents that is not a record is ignored', () => {
  const { id } = registerAgent(claude, 1_000);
  const folder = dirname(agentFiles()[0]);
  writeFileSync(join(folder, 'junk.json'), '{"id":');
  writeFileSync(join(folder, 'ffffffffffff.json'), JSON.stringify({ id: 'ffffffffffff', harness: 7 }));
  assert.deepEqual(listAgents(1_000).map(agent => agent.id), [id]);
});

test('an agent not seen for seven days is removed', () => {
  const { id } = registerAgent(claude, 0);
  pruneAgents(AGENT_KEEP_MS);
  assert.equal(readAgent(id)?.id, id);
  pruneAgents(AGENT_KEEP_MS + 1);
  assert.equal(readAgent(id), null);
});

// A record as it is made, read back and cleaned; the order and the numbers of the list; records
// that do not fit; and the removal, the empty list and the modes of the records.

test('a registered agent is read back as it was made, with every part cleaned', () => {
  const agent = registerAgent({ harness: ' claude\u200B-code ', about: 'landing\tpage\ncopy', folder: '/x/my\u202E-site' }, 5);
  assert.deepEqual(agent, { id: agent.id, harness: 'claude-code', about: 'landing page copy', folder: 'my-site',
    registered: 5, seen: 5 });
  assert.deepEqual(readAgent(agent.id), agent);
});

test('white space that is a control character becomes a space, and a cut counts code points', () => {
  assert.equal(cleanPart('a\tb\r\nc\u0085d'), 'a b c d');
  assert.equal(cleanPart('a \u0007 b'), 'a b');
  assert.equal(cleanPart('\u{1F600}'.repeat(100)), '\u{1F600}'.repeat(PART_MAX));
  assert.equal(cleanPart(`${'x'.repeat(PART_MAX - 1)} y`), 'x'.repeat(PART_MAX - 1));
});

test('a sign of life cleans the new description', () => {
  const { id } = registerAgent(claude, 0);
  assert.equal(seenAgent(id, '  checkout\u202E \n form ', 10)?.about, 'checkout form');
  assert.equal(readAgent(id)?.seen, 10);
});

test('agents that read differently get no number', () => {
  registerAgent(claude, 1_000);
  registerAgent({ ...claude, about: 'checkout form' }, 2_000);
  assert.deepEqual(listAgents(2_000).map(agent => agent.number), [null, null]);
});

test('agents are listed by the time they registered, then by id', () => {
  const first = registerAgent(claude, 0);
  const folder = dirname(agentFiles()[0]);
  for (const [id, registered] of [['bbbbbbbbbbbb', 2_000], ['cccccccccccc', 1_000], ['aaaaaaaaaaaa', 2_000]] as const) {
    writeFileSync(join(folder, `${id}.json`), JSON.stringify({ ...claude, folder: 'my-site', id, registered, seen: 3_000 }));
  }
  assert.deepEqual(listAgents(3_000).map(agent => agent.id),
    [first.id, 'cccccccccccc', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
});

test('a record under the name of another id is ignored', () => {
  const { id } = registerAgent(claude, 1_000);
  const folder = dirname(agentFiles()[0]);
  writeFileSync(join(folder, 'ffffffffffff.json'), JSON.stringify({ ...readAgent(id) }));
  assert.equal(readAgent('ffffffffffff'), null);
  assert.deepEqual(listAgents(1_000).map(agent => agent.id), [id]);
});

test('a removed agent is gone', () => {
  const { id } = registerAgent(claude, 1_000);
  removeAgent(id);
  assert.equal(readAgent(id), null);
  assert.deepEqual(listAgents(1_000), []);
  assert.deepEqual(agentFiles(), []);
});

test('without any agent the list is empty and pruning does nothing', () => {
  assert.deepEqual(listAgents(), []);
  pruneAgents();
  assert.deepEqual(readdirSync(dir), []);
});

test('an agent record and its folder are user-only', { skip: process.platform === 'win32' }, () => {
  registerAgent(claude, 1_000);
  const [file] = agentFiles();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
});
