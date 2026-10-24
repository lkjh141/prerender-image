'use strict';

// The rules for merging a pull request without a person pressing the button. This file only decides; scripts/automerge.js
// reads the facts from GitHub and acts on the answer. Every rule has a test in test/automerge-policy.test.js.
//
//   A pull request is merged when ALL of these hold:
//     - it is open, not a draft, targets main, comes from this repository (never a fork), and has no `do-not-merge` or `hold` label
//     - the `Verified` check passed on its current head commit
//     - GitHub says it is mergeable and up to date (state "clean")
//     - AND one of:
//         a) it is a Dependabot update of ONE dependency, patch or minor, from x.y.z to x.y.z, every commit written by Dependabot,
//            touching only dependency files. A major step, or a 0.x minor step (which may break), is never merged this way.
//         b) a person with write access approved the current head commit, and nobody with write access asks for changes.
//   Major Dependabot updates therefore wait for a person: path (b) is the approval gate.

const REQUIRED_CHECK = 'Verified';
const BLOCKING_LABELS = ['do-not-merge', 'hold'];
const WRITERS = new Set(['admin', 'maintain', 'write']);
const DEPENDENCY_FILES = [/^package\.json$/, /^package-lock\.json$/, /^Dockerfile$/, /^\.github\/workflows\/[\w.-]+\.ya?ml$/];
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** "Bump name from 1.2.3 to 1.2.4" -> { name, from, to }. Group updates, digests and anything unusual give null. */
function parseBump(title) {
  const match = /^(?:[\w-]+(?:\([\w./-]+\))?!?:\s*)?bump\s+(\S+)\s+from\s+(\S+)\s+to\s+(\S+?)(?:\s+in\s+\S+)?$/i.exec(String(title || '').trim());
  return match ? { name: match[1], from: match[2], to: match[3] } : null;
}

/** 'patch' | 'minor' | 'major' | 'invalid'. A 0.x minor step counts as major, because in 0.x a minor step may break. */
function classifyUpdate(from, to) {
  const a = SEMVER.exec(String(from));
  const b = SEMVER.exec(String(to));
  if (!a || !b) return 'invalid';
  const [x, y] = [a, b].map(m => m.slice(1).map(Number));
  if (x[0] !== y[0]) return y[0] > x[0] ? 'major' : 'invalid';
  if (x[0] === 0 && x[1] !== y[1]) return y[1] > x[1] ? 'major' : 'invalid';
  if (x[1] !== y[1]) return y[1] > x[1] ? 'minor' : 'invalid';
  if (x[2] !== y[2]) return y[2] > x[2] ? 'patch' : 'invalid';
  return 'invalid';
}

function isDependabotAutoMergeable({ pr, files, commits }) {
  if (!pr.user || pr.user.login !== 'dependabot[bot]' || pr.user.type !== 'Bot') return { ok: false, reason: 'not a Dependabot pull request' };
  const bump = parseBump(pr.title);
  if (!bump) return { ok: false, reason: 'not a single-dependency version bump (group, digest or unusual title): needs a person' };
  const kind = classifyUpdate(bump.from, bump.to);
  if (kind === 'major') return { ok: false, reason: `major update of ${bump.name} (${bump.from} -> ${bump.to}): needs a person's approval` };
  if (kind === 'invalid') return { ok: false, reason: `version step ${bump.from} -> ${bump.to} is not a plain upgrade: needs a person` };
  if (!commits.length || commits.some(c => !c.author || c.author.login !== 'dependabot[bot]')) {
    return { ok: false, reason: 'a commit on this branch was not written by Dependabot' };
  }
  if (!files.length || files.some(name => !DEPENDENCY_FILES.some(pattern => pattern.test(name)))) {
    return { ok: false, reason: 'the change touches files other than dependency files' };
  }
  return { ok: true, reason: `${kind} update of ${bump.name} (${bump.from} -> ${bump.to})`, kind };
}

/** Latest review per person, ignoring comments and the author. */
function latestReviews(reviews, authorLogin) {
  const latest = new Map();
  for (const review of [...reviews].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))) {
    if (!review.user || review.user.login === authorLogin) continue;
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue; // a plain comment changes nothing
    latest.set(review.user.login, review);
  }
  return latest;
}

function isApprovedByWriter({ pr, reviews, permissions }) {
  const latest = latestReviews(reviews, pr.user && pr.user.login);
  let approved = null;
  for (const [login, review] of latest) {
    const writer = WRITERS.has(permissions[login]);
    if (review.state === 'CHANGES_REQUESTED' && writer) return { ok: false, reason: `${login} asked for changes` };
    if (review.state === 'APPROVED' && writer && review.commit_id === pr.head.sha) approved = login;
  }
  return approved ? { ok: true, reason: `approved by ${approved} on the current commit`, by: approved } : { ok: false, reason: 'no approval from a person with write access on the current commit' };
}

/**
 * @returns {{ merge: boolean, reason: string, via?: string, approve?: boolean }}
 */
function evaluate({ pr, reviews = [], files = [], commits = [], permissions = {}, checks = [] }) {
  if (pr.state !== 'open' || pr.merged) return { merge: false, reason: 'not open' };
  if (pr.draft) return { merge: false, reason: 'draft' };
  if (pr.base.ref !== 'main') return { merge: false, reason: 'does not target main' };
  if (!pr.head.repo || pr.head.repo.full_name !== pr.base.repo.full_name) return { merge: false, reason: 'from a fork: never merged automatically' };
  const labels = (pr.labels || []).map(l => String(l.name).toLowerCase());
  if (BLOCKING_LABELS.some(l => labels.includes(l))) return { merge: false, reason: 'held by a label' };

  const verified = checks
    .filter(c => c.name === REQUIRED_CHECK && c.app && c.app.slug === 'github-actions')
    .sort((a, b) => String(b.completed_at || b.started_at).localeCompare(String(a.completed_at || a.started_at)))[0];
  if (!verified) return { merge: false, reason: `waiting for the ${REQUIRED_CHECK} check` };
  if (verified.status !== 'completed') return { merge: false, reason: `the ${REQUIRED_CHECK} check is still running` };
  if (verified.conclusion !== 'success') return { merge: false, reason: `the ${REQUIRED_CHECK} check ${verified.conclusion}` };
  if (pr.mergeable_state !== 'clean') return { merge: false, reason: `GitHub reports the pull request as "${pr.mergeable_state}", not "clean"` };

  const bot = isDependabotAutoMergeable({ pr, files, commits });
  if (bot.ok) return { merge: true, via: 'dependabot', reason: bot.reason, approve: true };
  const person = isApprovedByWriter({ pr, reviews, permissions });
  if (person.ok) return { merge: true, via: 'approval', reason: person.reason };
  return { merge: false, reason: `${bot.reason}; ${person.reason}` };
}

module.exports = { evaluate, parseBump, classifyUpdate, isDependabotAutoMergeable, isApprovedByWriter, latestReviews, REQUIRED_CHECK };
