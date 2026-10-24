# Security

## Reporting a problem

Please report a vulnerability in this repository's code, Dockerfile or workflows privately, using GitHub's
"Report a vulnerability" button on the Security tab of this repository. Do not open a public issue for it.

For a vulnerability in Prerender, Chromium, Node.js or Alpine themselves, report it to those projects. This repository picks up their
fixes through the weekly rebuild.

## What is and is not covered

The build fails when the image has a HIGH or CRITICAL vulnerability that already has a fix. A vulnerability without a fix yet cannot
block the build; it is shown in the scan output of each run. The image is rebuilt from scratch every Monday so fixes arrive within a week.

The service renders pages with a real browser. Read the "Security notes" in the README before you expose it to anything but your own
web server.
