'use strict';

// Looks at every open pull request against main and merges the ones scripts/automerge-policy.js allows. It is safe to run as
// often as you like: a pull request that is not ready is simply left alone. It never checks out or runs code from a pull request;
// it only reads facts from the GitHub API.

const { execFileSync } = require('node:child_process');
const { evaluate } = require('./automerge-policy');

function ghApi(args, input) {
  return JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 }) || 'null');
}

/** A GitHub API function with the same shape as the one the tests pass in: (method, path, body?) -> parsed JSON. */
function createApi() {
  return (method, path, body) => {
    const args = method === 'GET' ? ['--paginate', '--slurp', path] : ['--method', method, path, '--input', '-'];
    const result = ghApi(args, body === undefined ? undefined : JSON.stringify(body));
    // --paginate --slurp returns an array of pages; flatten array pages, unwrap the check-runs wrapper.
    if (method === 'GET' && Array.isArray(result)) {
      return result.flatMap(page => (Array.isArray(page) ? page : page && page.check_runs ? page.check_runs : [page]));
    }
    return result;
  };
}

async function sweep({ api, repo, log = console.log, dispatchBuild = true }) {
  const results = [];
  const open = await api('GET', `repos/${repo}/pulls?state=open&base=main&per_page=50`);
  let merged = 0;
  for (const summary of open) {
    const number = summary.number;
    const pr = (await api('GET', `repos/${repo}/pulls/${number}`))[0];
    // GitHub works out mergeability in the background; "unknown" means ask again later.
    const [reviews, files, commits, checks] = await Promise.all([
      api('GET', `repos/${repo}/pulls/${number}/reviews?per_page=100`),
      api('GET', `repos/${repo}/pulls/${number}/files?per_page=100`),
      api('GET', `repos/${repo}/pulls/${number}/commits?per_page=100`),
      api('GET', `repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`),
    ]);
    const permissions = {};
    for (const login of new Set(reviews.filter(r => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED').map(r => r.user && r.user.login).filter(Boolean))) {
      try { permissions[login] = (await api('GET', `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`))[0].permission; } catch { permissions[login] = 'none'; }
    }
    const decision = evaluate({ pr, reviews, files: files.map(f => f.filename), commits, permissions, checks });
    log(`#${number} ${JSON.stringify(pr.title)}: ${decision.merge ? 'MERGE' : 'wait'} - ${decision.reason}`);
    results.push({ number, ...decision });
    if (!decision.merge) continue;

    if (decision.approve) {
      // Lets a repository that requires one approval accept a safe Dependabot update. Needs the setting "Allow GitHub Actions to
      // create and approve pull requests"; without it the merge below still goes ahead where no approval is required.
      try { await api('POST', `repos/${repo}/pulls/${number}/reviews`, { event: 'APPROVE', commit_id: pr.head.sha, body: 'Approved automatically: a patch or minor dependency update that passed the Verified check.' }); } catch (error) { log(`#${number}: could not add an approval (${String(error.message).split('\n')[0]})`); }
    }
    try {
      // `sha` makes GitHub refuse the merge if a commit was pushed after we looked.
      await api('PUT', `repos/${repo}/pulls/${number}/merge`, { merge_method: 'squash', sha: pr.head.sha });
      merged += 1;
      log(`#${number}: merged`);
    } catch (error) {
      log(`#${number}: not merged (${String(error.message).split('\n')[0]})`);
    }
  }
  if (merged > 0 && dispatchBuild) {
    // A merge made with the workflow's own token does not start the push workflows, so start the build for main by hand. That
    // run is the verification and publication of what was merged.
    await api('POST', `repos/${repo}/actions/workflows/build.yml/dispatches`, { ref: 'main' });
    log('started the Build workflow on main');
  }
  return results;
}

if (require.main === module) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) { console.error('GITHUB_REPOSITORY is not set'); process.exit(1); }
  sweep({ api: createApi(), repo }).catch(error => { console.error(error.message); process.exit(1); });
}

module.exports = { sweep, createApi };
