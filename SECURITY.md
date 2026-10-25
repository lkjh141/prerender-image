# Security

## Reporting a problem

A vulnerability in this repository's code, Dockerfile or workflows should be reported privately, using GitHub's
"Report a vulnerability" button on the Security tab of this repository. A public issue is the wrong place for it, because it
would describe the problem to everyone before a fix exists.

A vulnerability in Prerender, Chromium, Node.js or Alpine themselves belongs to those projects and should be reported to them. This repository picks up their
fixes through the weekly rebuild, so a fix released upstream reaches the image without any change here.

## What is and is not covered

The build fails when the image has a HIGH or CRITICAL vulnerability that already has a fix. A fix that exists but is not yet in the image is something the
maintainers can act on, so the build stops until it is. A vulnerability without a fix yet cannot
block the build, because there is nothing to apply; it is shown in the scan output of each run. The image is rebuilt from scratch every Monday so fixes arrive within a week.

The service renders pages with a real browser, and a browser parses hostile input by design. The "Security notes" in the README should be read before the service is exposed to anything but the operator's own
web server. The [threat model](docs/threat-model.md) lists each way in, what stops it, and the risks that remain.
