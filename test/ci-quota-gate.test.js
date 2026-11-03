'use strict';

// Contract for ci/quota-gate.sh, the wrapper that lets a usage-limited check pass ONLY when its own output says the limit was reached.
// Every other failure must keep its exit status, or the wrapper would hide real findings.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const gate = path.join(__dirname, '..', 'ci', 'quota-gate.sh');

function withSummary(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'quota-gate-'));
  const summary = path.join(dir, 'summary.md');
  writeFileSync(summary, '');
  try {
    return fn(summary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(shellCommand) {
  return withSummary(summary => {
    const result = spawnSync('bash', [gate, 'zizmor', '--', 'sh', '-c', shellCommand], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary },
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
  const r = run('echo "HTTP status client error (403): API rate limit exceeded for installation" >&2; exit 1');
  assert.equal(r.status, 0);
  assert.match(r.output, /::warning title=zizmor usage limit reached::zizmor did not run/);
  assert.match(r.summary, /zizmor: usage limit reached/);
  assert.match(r.output, /API rate limit exceeded/, 'the tool output is still printed');
});

test('the other usual wordings of a usage limit are recognised', () => {
  for (const line of ['secondary rate limit triggered', 'usage limit has been reached for this month', 'monthly quota exceeded', 'HTTP 429 Too Many Requests', 'status code: 429']) {
    assert.equal(run(`echo "${line}"; exit 3`).status, 0, `"${line}" is a usage limit`);
  }
});

test('limit-like words inside a finding do not turn the failure into a pass', () => {
  const r = run('echo "error[unsafe-rate-limiter]: this rate limiting code is unsafe"; echo "limit is 5 per run"; exit 9');
  assert.equal(r.status, 9);
});

test('an authorisation or network error is a real failure, not a usage limit', () => {
  assert.equal(run('echo "HTTP status client error (401 Unauthorized) for url"; exit 1').status, 1);
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
