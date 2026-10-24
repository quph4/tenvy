# Security

Please report security problems **privately**, not in a public issue:
use **"Report a vulnerability"** on this repository's *Security* tab.

Things we especially want to hear about:

- provider logins or stream URLs leaking (logs, diagnostics, crash output,
  network requests to anyone other than the user's provider);
- a playlist, guide or provider response that can make Tenvy run commands,
  read local files, or pass options to mpv;
- ways around the parental PIN that don't require access to the Windows
  account;
- anything that weakens update signing (a tampered update being installed).

Please don't include real provider credentials in a report — the local test
provider (`pnpm test-provider`) is usually enough to show a problem.

We'll reply as soon as we can and credit you in the release notes if you'd
like.

Only the latest release is supported; fixes ship as a new version through
the in-app updater and the Microsoft Store.
