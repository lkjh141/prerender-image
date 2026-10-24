'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, parseBump, classifyUpdate } = require('../scripts/automerge-policy');

const bot = { login: 'dependabot[bot]', type: 'Bot' };
const human = { login: 'author', type: 'User' };
const ciOk = [{ name: 'Verified', status: 'completed', conclusion: 'success', completed_at: '2026-10-24T10:00:00Z', app: { slug: 'github-actions' } }];
const botCommits = [{ author: { login: 'dependabot[bot]' } }];
const pr = (over = {}) => ({
  state: 'open', merged: false, draft: false, mergeable_state: 'clean', title: 'Bump left-pad from 1.2.3 to 1.2.4', labels: [], user: bot,
  base: { ref: 'main', repo: { full_name: 'o/r' } }, head: { sha: 'abc', repo: { full_name: 'o/r' } }, ...over,
});
const run = (over = {}, extra = {}) => evaluate({ pr: pr(over), files: ['package.json', 'package-lock.json'], commits: botCommits, checks: ciOk, ...extra });

test('titles: only a single plain version bump is understood', () => {
  assert.deepEqual(parseBump('Bump express from 4.21.2 to 4.22.0'), { name: 'express', from: '4.21.2', to: '4.22.0' });
  assert.deepEqual(parseBump('chore(deps): bump a/b from 1.0.0 to 1.0.1'), { name: 'a/b', from: '1.0.0', to: '1.0.1' });
  assert.deepEqual(parseBump('Bump node from 22.1.0 to 22.2.0 in /'), { name: 'node', from: '22.1.0', to: '22.2.0' });
  for (const no of ['Bump the npm group with 3 updates', 'Bump x from 1 to 2 and y from 3 to 4', 'Update x', '', null, 'bump x from 1.0.0', 'Bump the actions group across 1 directory with 2 updates']) assert.equal(parseBump(no), null, String(no));
});

test('update kinds: 0.x minor steps, downgrades, pre-releases and digests are never "safe"', () => {
  const cases = [['1.2.3', '1.2.4', 'patch'], ['1.2.3', '1.3.0', 'minor'], ['1.2.3', '2.0.0', 'major'], ['v1.2.3', 'v1.2.4', 'patch'],
    ['0.5.1', '0.5.2', 'patch'], ['0.5.1', '0.6.0', 'major'], ['0.5.1', '1.0.0', 'major'],
    ['1.2.3', '1.2.2', 'invalid'], ['1.3.0', '1.2.9', 'invalid'], ['2.0.0', '1.9.9', 'invalid'], ['1.2.3', '1.2.3', 'invalid'],
    ['1.2.3', '1.2.4-beta.1', 'invalid'], ['1.2.3', '1.2.4+build', 'invalid'], ['abc1234', 'def5678', 'invalid'], ['1.2', '1.3', 'invalid'], ['22-alpine3.22', '22-alpine3.23', 'invalid']];
  for (const [from, to, want] of cases) assert.equal(classifyUpdate(from, to), want, `${from} -> ${to}`);
});

test('a green patch or minor Dependabot update is merged and approved by the workflow', () => {
  for (const title of ['Bump left-pad from 1.2.3 to 1.2.4', 'Bump left-pad from 1.2.3 to 1.9.0']) {
    const d = run({ title });
    assert.equal(d.merge, true, title);
    assert.equal(d.via, 'dependabot');
    assert.equal(d.approve, true);
  }
});

test('a major Dependabot update waits for a person, then merges once a writer approves the current commit', () => {
  const title = 'Bump left-pad from 1.2.3 to 2.0.0';
  const waiting = run({ title });
  assert.equal(waiting.merge, false);
  assert.match(waiting.reason, /major/);
  const approved = run({ title }, { reviews: [{ user: { login: 'maintainer' }, state: 'APPROVED', commit_id: 'abc', submitted_at: '2026-10-24T11:00:00Z' }], permissions: { maintainer: 'write' } });
  assert.equal(approved.merge, true);
  assert.equal(approved.via, 'approval');
  const stale = run({ title }, { reviews: [{ user: { login: 'maintainer' }, state: 'APPROVED', commit_id: 'OLD', submitted_at: '2026-10-24T11:00:00Z' }], permissions: { maintainer: 'write' } });
  assert.equal(stale.merge, false, 'an approval of an older commit does not count');
  const bystander = run({ title }, { reviews: [{ user: { login: 'rando' }, state: 'APPROVED', commit_id: 'abc', submitted_at: '2026-10-24T11:00:00Z' }], permissions: { rando: 'read' } });
  assert.equal(bystander.merge, false, 'a reader\'s approval does not count');
});

test('Dependabot updates that are not a single plain bump are left to a person', () => {
  for (const title of ['Bump the npm group with 3 updates', 'Bump node from 22-alpine3.22 to 22-alpine3.23', 'Bump x from 0.5.1 to 0.6.0', 'Bump x from 1.2.3 to 1.2.4-rc.1']) {
    assert.equal(run({ title }).merge, false, title);
  }
});

test('a Dependabot branch with a foreign commit or unexpected files is not merged automatically', () => {
  assert.equal(evaluate({ pr: pr(), files: ['package.json'], commits: [...botCommits, { author: { login: 'someone' } }], checks: ciOk }).merge, false);
  assert.equal(evaluate({ pr: pr(), files: ['package.json'], commits: [{ author: null }], checks: ciOk }).merge, false);
  for (const files of [['package.json', 'server.js'], ['lib/front.js'], ['.github/workflows/automerge.yml', 'scripts/automerge.js'], ['package.json', '.github/CODEOWNERS'], []]) {
    assert.equal(evaluate({ pr: pr(), files, commits: botCommits, checks: ciOk }).merge, false, files.join());
  }
  assert.equal(evaluate({ pr: pr(), files: ['package.json', 'package-lock.json', 'Dockerfile', '.github/workflows/build.yml'], commits: botCommits, checks: ciOk }).merge, true);
});

test('a person pretending to be Dependabot is not trusted', () => {
  assert.equal(run({ user: { login: 'dependabot[bot]', type: 'User' } }).merge, false);
  assert.equal(run({ user: { login: 'dependabot-fake[bot]', type: 'Bot' } }).merge, false);
  assert.equal(run({ user: human }).merge, false);
});

test('nothing merges before the Verified check has passed on the current commit', () => {
  const check = over => [{ ...ciOk[0], ...over }];
  assert.equal(evaluate({ pr: pr(), files: ['package.json'], commits: botCommits, checks: [] }).merge, false);
  assert.equal(evaluate({ pr: pr(), files: ['package.json'], commits: botCommits, checks: check({ status: 'in_progress', conclusion: null }) }).merge, false);
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
    assert.equal(evaluate({ pr: pr(), files: ['package.json'], commits: botCommits, checks: check({ conclusion }) }).merge, false, conclusion);
  }
  assert.equal(evaluate({ pr: pr(), files: ['package.json'], commits: botCommits, checks: check({ name: 'Tests' }) }).merge, false, 'another check does not stand in');
  assert.equal(evaluate({ pr: pr(), files: ['package.json'], commits: botCommits, checks: check({ app: { slug: 'evil-app' } }) }).merge, false, 'a look-alike check from another app is ignored');
  const newest = [{ ...ciOk[0], conclusion: 'failure', completed_at: '2026-10-24T12:00:00Z' }, ...ciOk];
  assert.equal(evaluate({ pr: pr(), files: ['package.json'], commits: botCommits, checks: newest }).merge, false, 'the newest result wins');
});

test('state, target, draft, fork and hold labels all stop a merge', () => {
  for (const over of [{ state: 'closed' }, { merged: true }, { draft: true }, { mergeable_state: 'behind' }, { mergeable_state: 'dirty' }, { mergeable_state: 'blocked' }, { mergeable_state: 'unstable' },
    { base: { ref: 'release', repo: { full_name: 'o/r' } } }, { head: { sha: 'abc', repo: { full_name: 'fork/r' } } }, { head: { sha: 'abc', repo: null } },
    { labels: [{ name: 'hold' }] }, { labels: [{ name: 'Do-Not-Merge' }] }]) {
    assert.equal(run(over).merge, false, JSON.stringify(over));
  }
});

test('human pull requests: approval of the current commit by a writer, and a change request from a writer blocks', () => {
  const base = { user: human, title: 'Add a thing' };
  const review = (login, state, commit = 'abc', at = '2026-10-24T11:00:00Z') => ({ user: { login }, state, commit_id: commit, submitted_at: at });
  const go = (reviews, permissions) => evaluate({ pr: pr(base), files: ['server.js'], commits: [{ author: { login: 'author' } }], checks: ciOk, reviews, permissions });
  assert.equal(go([], {}).merge, false, 'no review');
  assert.equal(go([review('m', 'APPROVED')], { m: 'write' }).merge, true);
  assert.equal(go([review('m', 'APPROVED')], { m: 'admin' }).merge, true);
  assert.equal(go([review('m', 'APPROVED')], { m: 'triage' }).merge, false);
  assert.equal(go([review('author', 'APPROVED')], { author: 'admin' }).merge, false, 'self-approval does not count');
  assert.equal(go([review('m', 'APPROVED'), review('n', 'CHANGES_REQUESTED')], { m: 'write', n: 'write' }).merge, false, 'a change request blocks');
  assert.equal(go([review('m', 'APPROVED'), review('n', 'CHANGES_REQUESTED')], { m: 'write', n: 'read' }).merge, true, 'a reader\'s change request is only advice');
  assert.equal(go([review('m', 'CHANGES_REQUESTED', 'abc', '2026-10-24T10:00:00Z'), review('m', 'APPROVED', 'abc', '2026-10-24T11:00:00Z')], { m: 'write' }).merge, true, 'a later approval replaces an earlier request');
  assert.equal(go([review('m', 'APPROVED', 'abc', '2026-10-24T10:00:00Z'), review('m', 'CHANGES_REQUESTED', 'abc', '2026-10-24T11:00:00Z')], { m: 'write' }).merge, false, 'a later request replaces an earlier approval');
  assert.equal(go([review('m', 'APPROVED', 'abc', '2026-10-24T10:00:00Z'), review('m', 'COMMENTED', 'abc', '2026-10-24T11:00:00Z')], { m: 'write' }).merge, true, 'a later comment does not withdraw approval');
  assert.equal(go([review('m', 'APPROVED'), review('m', 'DISMISSED', 'abc', '2026-10-24T12:00:00Z')], { m: 'write' }).merge, false, 'a dismissed review is gone');
});
