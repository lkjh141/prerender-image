#!/usr/bin/env bash
# Runs one command that calls a service with a usage limit (a GitHub API budget, a monthly scan quota).
#
# When the command fails AND its output says the limit was reached, the step passes with a warning, because a limit must not
# block the build. The warning and the job summary say that the scan did not run. Every other failure keeps the command's own
# exit status: a finding, a crash, a bad configuration, or a network error that is not a limit still fails the step. The full
# log is printed either way, so nothing the tool said is hidden.
#
# Usage: tools/ci/quota-gate.sh <name> -- <command> [arguments...]
set -uo pipefail

name="${1:-}"
[ -n "$name" ] || { echo "quota-gate: a name is required" >&2; exit 2; }
shift
[ "${1:-}" = "--" ] && shift
[ "$#" -gt 0 ] || { echo "quota-gate: no command given" >&2; exit 2; }

# The wording services use when a usage limit is exhausted. Kept specific on purpose: a finding that merely contains the
# word "limit" or "rate" does not match.
QUOTA_PATTERN='API rate limit exceeded|secondary rate limit|rate limit (has been )?exceeded|usage limit (has been |was )?(reached|exceeded)|monthly (limit|quota) (reached|exceeded)|quota (has been )?(reached|exceeded)|HTTP[^ ]* 429|status( code)?:? 429|too many requests'

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

"$@" >"$log" 2>&1
status=$?
cat "$log"

if [ "$status" -eq 0 ]; then
  exit 0
fi

# zizmor, and other tools that call the REST API, report a refused request only as its status and URL, for example
# "HTTP status client error (403 Forbidden) for url (https://api.github.com/...)". GitHub answers an exhausted budget with a 403,
# so for api.github.com the budget decides: a budget with nothing left (remaining 0) is a usage limit. Any other 403 is not.
rest_budget_exhausted() {
  grep -Eq 'HTTP status client error \(403[^)]*\) for url \(https://api\.github\.com/' "$log" || return 1
  local remaining
  remaining="$("${QUOTA_GATE_GH:-gh}" api rate_limit --jq '.resources.core.remaining' 2>/dev/null)" || return 1
  [ "$remaining" = "0" ]
}

# A tool that reports findings prints one diagnostic per finding (zizmor: error[rule], warning[rule], info[rule], help[rule], note[rule]).
# A finding is never a usage limit, even when its text quotes limit wording, so any diagnostic keeps the tool's own exit status.
has_finding_diagnostics() {
  grep -Eq '^(error|warning|info|help|note)\[' "$log"
}

if ! has_finding_diagnostics && { grep -Eiq -- "$QUOTA_PATTERN" "$log" || rest_budget_exhausted; }; then
  message="$name did not run: its usage limit was reached (exit $status). This run was not scanned by $name. The next run of this check covers it."
  echo "::warning title=$name usage limit reached::$message"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '### %s: usage limit reached\n\n%s\n' "$name" "$message" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 0
fi

exit "$status"
