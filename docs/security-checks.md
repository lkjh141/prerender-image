# Security checks and usage limits

This page lists every check that runs on this repository, whether it can block a merge, what usage limit it has, and the owner settings
that the files cannot make. The rules for what a usage limit may do are in the last two sections.

## The checks

| Check | Where | Blocks a merge? | Usage limit | Notes |
| --- | --- | --- | --- | --- |
| Unit tests, production audit, browser suites | `build.yml` (`test`, `adversarial`) | Yes, through **Verified** | None | Existing. |
| Image build, smoke test, attack suites, Trivy | `build.yml` (`image`) | Yes, through **Verified** | None | Existing. The job has no write permission. |
| Publish and attest | `build.yml` (`publish`) | Runs on pushes only; a failure fails **Verified** | None | Holds the only write permissions in the build. |
| Verify the published image | `build.yml` (`verify-published`) | Yes, on pushes | None | Existing. |
| Secret scan (gitleaks 8.30.1) | `build.yml` (`secrets`) | Yes, through **Verified** | None | A generated canary must be flagged; otherwise the job fails. |
| Workflow lint (zizmor 1.31.1) | `build.yml` (`workflow-lint`) | Yes at medium and high, through **Verified** | GitHub API budget for the online audits | Runs through `ci/quota-gate.sh`. Low-severity hints do not block. |
| Dockerfile lint (hadolint 2.14.0) | `build.yml` (`dockerfile-lint`) | Yes, through **Verified** | None | The binary is checked against its SHA-256 first. |
| CodeQL (JavaScript) | `codeql.yml` (advanced setup) | No, unless you make it a required check | None for public repositories | Needs the default setup turned off (owner, see below). |
| OpenSSF Scorecard | `scorecard.yml` | No; informational | GitHub API budget | Runs through a usage-limit decision (last section). |
| Dependency review | `dependency-review.yml` | No, unless you make it a required check | None for public repositories | Fails at high severity. |
| Socket Security (GitHub App) | Installed by the owner | No, unless you make it required | Free plan limits (check the Socket plan page) | Flags malicious npm releases in pull requests. |
| Mend Bolt, Aikido, PR Insights Tagger, DepChecker Bot (GitHub Apps) | Installed by the owner, optional | No, unless you make them required | Mend Bolt: 5 scans per repository per day. Aikido: 2 repositories on the free plan. | Optional. Read each app's data terms before installing. |

## What a usage limit may and may not do

1. **A usage limit may skip a scan. It may never pass a finding.** `ci/quota-gate.sh` passes a step only when the tool's own output says
   the limit was reached (for example `API rate limit exceeded`, `secondary rate limit`, `monthly quota exceeded`, `HTTP 429`). A finding, a
   crash, a bad configuration, an authorisation error or a network error keeps the tool's exit status. The wording it recognises is tested in
   `test/ci-quota-gate.test.js`. A finding is never a usage limit: when the output contains a tool diagnostic (for zizmor, a line starting
   `error[`, `warning[`, `info[`, `help[` or `note[`), the step keeps the tool's exit status, even if the text also quotes limit wording.
   zizmor reports a refused REST call only as its status and URL, so a 403 from `api.github.com` counts as a usage limit only when the
   job's GitHub API budget is at zero. Any other 403, and any 401, fails the step.
2. **A skipped scan is visible.** The step prints a `::warning` annotation and writes a note to the job summary saying that the scan did not
   run. The next run of the same check covers it again.
3. **Scorecard decides differently.** Scorecard reports errors, not findings, so a failed run has no output to read. The job instead checks
   its own GitHub API budget: if it is used up (`remaining` is 0), the failure is a usage limit and the job passes with a warning. Any other
   failure fails the job.
4. **GitHub Apps cannot be wrapped from this repository.** Their usage limits are enforced by the app. The only protection this repository
   can give is that none of them is a required check, so their limit failures cannot block a merge.

## Owner settings (cannot be set from files)

- **Secret protection and Dependabot security updates:** Settings → Code security. Both are free for a public repository. Turn on push
  protection for secret scanning.
- **CodeQL:** the advanced workflow `codeql.yml` is the CodeQL setup. The owner must turn off the repository's default setup under Settings →
  Code security. While the default setup is on, GitHub refuses the advanced workflow, and its run fails. Turn the default setup off first.
- **Branch protection on `main`:** require **Verified**. Do not add CodeQL, Scorecard, dependency review or any GitHub App to the required
  checks unless you accept that their usage-limit failures would then block merges.
- **Code owners (optional):** `.github/CODEOWNERS` takes effect only when "Require review from Code Owners" is on. With it on, a Dependabot
  update that touches `.github/workflows/`, `Dockerfile` or the auto-merge scripts waits for your review, because the auto-approval step is
  not a code-owner approval. Decide before turning it on.
- **GitHub Apps:** install the optional apps from the Marketplace as the owner. Each app's free plan has the limit in the table above.

## Known limits of this setup

- The publish job rebuilds the image from the build cache written by the scan job. In practice the layers are the same, but the image is
  built again, so the published digest is not the digest that was scanned. Pushing the scanned digest directly would close that gap. It is
  not changed here.
- zizmor's online audits, Scorecard and CodeQL can only run on GitHub. Their first result after these changes is the check.
