# Security policy

## Supported versions

PastePage is young. Security fixes go into the latest 0.x release only, so please update to the latest version before reporting.

| Version | Supported |
|---|---|
| Latest 0.x release | Yes |
| Older releases | No |

## Reporting a vulnerability

Please **don't** open a public issue for a security problem. Report it privately through GitHub instead:

1. Go to the repository's **Security and quality** tab (if you can't see it, it may be under the "..." menu).
2. Click **Report a vulnerability**. This button only exists once the maintainer has enabled private vulnerability reporting; if you don't see it, open a public issue asking for a private contact, without any details of the problem.
3. Describe the problem, how to reproduce it, and what an attacker could do with it.

The report goes privately to the maintainers. We can discuss the details there, work on the fix together, and publish a security advisory once it's fixed.

## What to expect

PastePage is made by SideBit, a one-person company. Reports are handled on a best-effort basis: I'll acknowledge your report as soon as I can, keep you informed, and credit you in the advisory if you'd like. I can't promise fixed response times.

## Scope

How the encryption works, and which limits are known and by design (for example, that people who have a session's password are trusted), is described in [docs/security.md](docs/security.md). Please check it first; reports that go beyond it are very welcome.
