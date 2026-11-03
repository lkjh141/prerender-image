'use strict';

// Contract for ci/quota-gate.sh, the wrapper that lets a usage-limited check pass ONLY when its own output says the limit was reached,
// or, for GitHub's REST API, when the budget is used up. Every other failure must keep its exit status, or the wrapper would hide real findings.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const gate = path.join(__dirname, '..', 'ci', 'quota-gate.sh');

// One scratch directory per test: a summary file and a stand-in for `gh` that prints the remaining REST budget (FAKE_REMAINING).
function scratch(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'quota-gate-'));
  try {
    const summary = path.join(dir, 'summary.md');
    const fakeGh = path.join(dir, 'fake-gh');
    writeFileSync(summary, '');
    writeFileSync(fakeGh, '#!/bin/sh\necho "$FAKE_REMAINING"\n');
    chmodSync(fakeGh, 0o755);
    return fn({ summary, fakeGh });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(shellCommand, { remaining = '4000' } = {}) {
  return scratch(({ summary, fakeGh }) => {
    const result = spawnSync('bash', [gate, 'zizmor', '--', 'sh', '-c', shellCommand], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, QUOTA_GATE_GH: fakeGh, FAKE_REMAINING: remaining },
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      summary: readFileSync(summary, 'utf8'),
    };
  });
}

test('a passing command passes unchanged, with no warning', () => {
  const r = run('echo all good');
  assert.equal(r.status, 0);
  assert.match(r.output, /all good/);
  assert.doesNotMatch(r.output, /::warning/);
});

test('a real finding keeps its exit status and writes no usage-limit note', () => {
  const r = run('echo "error[dangerous-triggers]: use of fundamentally insecure workflow trigger"; exit 14');
  assert.equal(r.status, 14);
  assert.doesNotMatch(r.output, /::warning/);
  assert.equal(r.summary, '');
});

test('an exhausted usage limit passes with a warning and a summary note', () => {
  const r = run('echo "HTTP status client error (403 Forbidden): API rate limit exceeded for installation" >&2; exit 1');
  assert.equal(r.status, 0);
  assert.match(r.output, /::warning title=zizmor usage limit reached::zizmor did not run/);
  assert.match(r.summary, /zizmor: usage limit reached/);
  assert.match(r.output, /API rate limit exceeded/, 'the tool output is still printed');
});

test('the other usual wordings of a usage limit are recognised', () => {
  const lines = [
    'secondary rate limit triggered',
    'usage limit has been reached for this month',
    'monthly quota exceeded',
    'HTTP 429 Too Many Requests',
    'status code: 429',
    'HTTP status client error (429 Too Many Requests) for url (https://github.com/actions/setup-node.git/git-upload-pack)',
  ];
  for (const line of lines) {
    assert.equal(run(`echo "${line}"; exit 3`).status, 0, `"${line}" is a usage limit`);
  }
});

test('limit-like words inside a finding do not turn the failure into a pass', () => {
  const r = run('echo "error[unsafe-rate-limiter]: this rate limiting code is unsafe"; echo "limit is 5 per run"; exit 9');
  assert.equal(r.status, 9);
});

test('a REST 403 from api.github.com is a usage limit only when the API budget is used up', () => {
  const refused = 'echo "HTTP status client error (403 Forbidden) for url (https://api.github.com/repos/x/y/tags)" >&2; exit 1';
  const exhausted = run(refused, { remaining: '0' });
  assert.equal(exhausted.status, 0);
  assert.match(exhausted.output, /::warning title=zizmor usage limit reached/);
  assert.equal(run(refused, { remaining: '4000' }).status, 1, 'budget left: not a usage limit');
});

test('a 403 from another host, or an authorisation error, is never decided by the API budget', () => {
  const otherHost = 'echo "HTTP status client error (403 Forbidden) for url (https://github.com/x/y.git/git-upload-pack)" >&2; exit 1';
  assert.equal(run(otherHost, { remaining: '0' }).status, 1);
  const unauthorised = 'echo "HTTP status client error (401 Unauthorized) for url (https://api.github.com/repos/x)" >&2; exit 1';
  assert.equal(run(unauthorised, { remaining: '0' }).status, 1);
});

test('another network error is a real failure, not a limit', () => {
  assert.equal(run("echo \"couldn't list tags: connection reset by peer\"; exit 4").status, 4);
});

test('a successful run that prints limit wording is still a pass, with no warning', () => {
  const r = run('echo "API rate limit exceeded but the audit completed"; exit 0');
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.output, /::warning/);
});

test('bad invocations are refused rather than passed', () => {
  assert.equal(spawnSync('bash', [gate], { encoding: 'utf8' }).status, 2, 'a name is required');
  assert.equal(spawnSync('bash', [gate, 'zizmor', '--'], { encoding: 'utf8' }).status, 2, 'a command is required');
});

test('the wrapper parses as bash', () => {
  assert.equal(spawnSync('bash', ['-n', gate], { encoding: 'utf8' }).status, 0);
});
