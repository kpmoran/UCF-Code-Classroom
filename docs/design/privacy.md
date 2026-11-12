# Student identifiers never reach GitHub

Assignment repositories are named `<prefix>-<github-login>`, and the GitHub login is the
only student identifier that leaves this application.

That is a deliberate reversal. Naming used to prefer the SIS login id — a UCF NID —
because it survives a student renaming their GitHub account and it sorts alongside the
Canvas roster. Both are true, and both lose to where a repository name ends up: visible
to everyone who can see the organization, in clone URLs, in Actions logs, in commit
metadata, and in any link a student pastes into a ticket or a chat. An NID is restricted
student information and does not belong in any of those.

Everything else that reaches GitHub was already clear of it, and it is worth knowing
where the boundary sits if you extend this:

| Sent to GitHub | Contains |
|---|---|
| Repository name | prefix + GitHub login |
| Repository description | GitHub login, or the team name for group work |
| Team name | assignment slug + team name |
| Feedback pull request | the word "Feedback" and generic body text |
| Autograding workflow and manifest | test names and commands, no identity at all |

NIDs, SIS user ids, emails and sections stay in Postgres and on the roster and grade
pages, which are staff-only. `names the repository from the GitHub login, never the NID`
in the provisioning integration test asserts both halves — the login is used, and the
NID appears nowhere in the name GitHub ends up with.

**Repositories provisioned before this change keep their old names.** Renaming one on
GitHub is safe — GitHub redirects both web and git traffic from the old name — but it has
to be done deliberately; nothing renames them automatically.
