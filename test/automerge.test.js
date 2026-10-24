'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sweep } = require('../scripts/automerge');

const ok = [{ name: 'Verified', status: 'completed', conclusion: 'success', completed_at: '2026-10-24T10:00:00Z', app: { slug: 'github-actions' } }];
function fakeGitHub(prs) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    let m;
    if (method === 'GET' && path.startsWith('repos/o/r/pulls?')) return prs.map(p => ({ number: p.number }));
    if (method === 'GET' && (m = /^repos\/o\/r\/pulls\/(\d+)$/.exec(path))) return [prs.find(p => p.number === Number(m[1])).pr];
    if (method === 'GET' && (m = /^repos\/o\/r\/pulls\/(\d+)\/(reviews|files|commits)/.exec(path))) return prs.find(p => p.number === Number(m[1]))[m[2]] || [];
    if (method === 'GET' && /check-runs/.test(path)) return ok;
    if (method === 'GET' && /collaborators/.test(path)) return [{ permission: 'write' }];
    if (method === 'PUT' && /merge$/.test(path)) { if (prs.find(p => path.includes(`/${p.number}/`)).failMerge) throw new Error('Head branch was modified'); return {}; }
    return {};
  };
  return { api, calls };
}
const basePr = over => ({
  state: 'open', merged: false, draft: false, mergeable_state: 'clean', labels: [], user: { login: 'dependabot[bot]', type: 'Bot' },
  title: 'Bump x from 1.0.0 to 1.0.1', base: { ref: 'main', repo: { full_name: 'o/r' } }, head: { sha: 'sha1', repo: { full_name: 'o/r' } }, ...over,
});

test('a safe Dependabot update is approved, merged with the checked commit, and the build for main is started', async () => {
  const gh = fakeGitHub([{ number: 5, pr: basePr(), files: [{ filename: 'package.json' }], commits: [{ author: { login: 'dependabot[bot]' } }] }]);
  const out = await sweep({ api: gh.api, repo: 'o/r', log: () => {} });
  assert.equal(out[0].merge, true);
  const merge = gh.calls.find(c => c.method === 'PUT');
  assert.deepEqual(merge.body, { merge_method: 'squash', sha: 'sha1' }, 'pinned to the commit that was checked');
  assert.ok(gh.calls.some(c => c.method === 'POST' && /reviews$/.test(c.path) && c.body.event === 'APPROVE'));
  assert.ok(gh.calls.some(c => c.method === 'POST' && /workflows\/build\.yml\/dispatches$/.test(c.path) && c.body.ref === 'main'));
});

test('a major update, a pull request in progress and an unverified one are all left alone', async () => {
  const gh = fakeGitHub([
    { number: 1, pr: basePr({ title: 'Bump x from 1.0.0 to 2.0.0' }), files: [{ filename: 'package.json' }], commits: [{ author: { login: 'dependabot[bot]' } }] },
    { number: 2, pr: basePr({ draft: true }), files: [{ filename: 'package.json' }], commits: [{ author: { login: 'dependabot[bot]' } }] },
    { number: 3, pr: basePr({ mergeable_state: 'blocked' }), files: [{ filename: 'package.json' }], commits: [{ author: { login: 'dependabot[bot]' } }] },
  ]);
  const out = await sweep({ api: gh.api, repo: 'o/r', log: () => {} });
  assert.deepEqual(out.map(o => o.merge), [false, false, false]);
  assert.equal(gh.calls.filter(c => c.method !== 'GET').length, 0, 'nothing was written');
});

test('a merge that GitHub refuses (the branch moved) is reported, does not stop the sweep, and starts no build', async () => {
  const logs = [];
  const gh = fakeGitHub([{ number: 7, failMerge: true, pr: basePr(), files: [{ filename: 'package.json' }], commits: [{ author: { login: 'dependabot[bot]' } }] }]);
  await sweep({ api: gh.api, repo: 'o/r', log: m => logs.push(m) });
  assert.ok(logs.some(l => /not merged/.test(l)));
  assert.ok(!gh.calls.some(c => /dispatches$/.test(c.path)));
});
