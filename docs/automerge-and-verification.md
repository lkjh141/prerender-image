# Verification and auto-merge

This page explains what the pipeline checks before an image is published, and the rules by which a pull request may merge without a person pressing the button.
The aim is that a change reaches `main` only after the same checks have passed on the exact commit being merged.

## What is verified, and when

Every pull request and every push to `main` runs `.github/workflows/build.yml`:

| Job | What it proves |
| --- | --- |
| Tests and dependency audit | Unit tests (no browser) pass and `npm audit --omit=dev` is clean. |
| Attack and load tests against a real browser | The SSRF, response, input and exhaustion suites in `test/adversarial/` pass against a real Chromium. |
| Build, test, scan and publish | The image builds, `scripts/smoke.sh` passes against it (read-only, no capabilities, non-root, clean shutdown), Trivy finds nothing fixable at HIGH or CRITICAL. On `main` it is then published with provenance and an SBOM. |
| Verify the published image | On `main` only: the image is pulled **by the digest that was just pushed**, smoke-tested again, and its build attestation is verified. |
| **Verified** | One result that is green only when all of the above are. Branch protection and the auto-merge workflow both key on this name. |

A weekly run rebuilds from scratch so Alpine and Chromium security fixes are picked up. Without it, the image would only change when someone changed the code,
and security fixes in the operating system packages would wait for that.

The jobs feed one result, **Verified**, on purpose. Branch protection and the auto-merge workflow then depend on a single name and not on a list of jobs, so a job can be
added or renamed without changing the repository rules.

## Auto-merge

`.github/workflows/automerge.yml` runs when Build finishes, when a review is submitted, hourly, and on demand. It runs
`scripts/automerge.js`, which applies the rules in `scripts/automerge-policy.js` (each rule has a test) to every open pull request
against `main`.

The script only ever merges. It never edits a pull request, and it takes its facts (checks, reviews, files, commits) from the GitHub API and not from the pull request's own code.

A pull request is merged (squash) when it is open, not a draft, from this repository (never a fork), not labelled `hold` or
`do-not-merge`, **`Verified` passed on its current head commit**, GitHub reports it `clean`, and one of these is true:

1. **Dependabot patch or minor update.** One dependency, `x.y.z` to `x.y.z`, patch or minor. Every commit is written by Dependabot and only
   dependency files change (`package.json`, `package-lock.json`, `Dockerfile`, workflow files). The workflow adds an approval and merges.
2. **Approved by a person.** Someone with write access approved the *current* head commit (a new push voids earlier approvals) and
   nobody with write access has requested changes.

Some pull requests are never merged automatically. They wait for a person, and path 2 is the approval gate:

- **Major** Dependabot updates, and `0.x` minor updates (in `0.x` a minor step may break).
- Group updates, Docker digest or tag updates, pre-releases, anything whose title is not a plain `Bump x from a.b.c to d.e.f`.
- A Dependabot branch with a commit by anyone else, or one that touches other files.
- Pull requests from forks.

The merge request carries the head commit's SHA, so GitHub refuses it if anything was pushed after the checks ran. This closes the gap between
"the checks passed" and "the merge happened". A merge made with the workflow's own token does not start push workflows (GitHub does this to prevent loops), so after merging the script
starts Build on `main` by hand. That run is the verification and publication of what was merged.

To hold a pull request, add the label `hold`.

## One-time repository settings (the code cannot set these)

The repository owner has to do these steps once.

1. **Settings, Actions, General, Workflow permissions:** tick *Allow GitHub Actions to create and approve pull requests*
   (lets the workflow approve safe Dependabot updates).
2. **Settings, Branches (or Rulesets), `main`:** require a pull request, require **1 approval**, require the status check
   **Verified**, require branches to be up to date, and do not allow bypass. Leave *Allow auto-merge* off; this workflow does not use it.
3. Only people the owner trusts should have **write** access, because their approval is what the second path trusts.
4. Optionally add a `hold` label.

The workflow does not depend on these settings for safety, because it checks `Verified` and approvals itself. Without them, though, a person can
still merge a red pull request by hand.

## Security notes

- The workflow never checks out pull request code and runs only the script from `main`. It uses the API for facts. A pull request therefore cannot change the rules that judge it.
- The `Verified` check is accepted only from the `github-actions` app, so another app cannot supply a look-alike.
- Workflow files can be changed by Dependabot (action version bumps, pinned by SHA with a seven-day cooldown). An operator who does not want
  that can remove the workflow pattern from `DEPENDENCY_FILES` in `scripts/automerge-policy.js`.
