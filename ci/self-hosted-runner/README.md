# Self-hosted CI runner (free GitHub Actions)

GitHub-hosted runners burn the repo's Actions-minute quota (2000/mo free, then
billed). A **self-hosted** runner executes jobs on your own machine/server and
costs **0 Actions minutes**. This dir runs one in Docker.

## Start
```sh
cd ci/self-hosted-runner
./start-runner.sh        # mints a token via gh, starts the container, stays registered
```
Then in GitHub: **Settings → Actions → General → Runners** should show
`manga-selfhosted-1` as *Idle*. The workflows use `runs-on: [self-hosted, linux]`,
so they will pick it up.

## Re-enable the workflows (they were disabled to stop the minute burn)
```sh
gh workflow enable CI
# (leave Deploy disabled until you're ready to ship)
```

## Stop
```sh
./stop-runner.sh
```

## Notes / cost control
- The CI workflow only triggers on **PRs targeting `master`** and **pushes to
  `master`** (not every feature-branch push), with `concurrency: cancel-in-progress`
  so force-pushes don't stack runs.
- The container is Linux even on a macOS host, so the workflow's `apt-get`
  (Cairo/Pango for node-canvas), `sudo`, `ruby`, and `setup-bun` steps all work.
- The runner only runs while this machine + Docker are up. For always-on CI, run
  `start-runner.sh` on an always-on server (any Docker host with `gh` authed).
- Security: a self-hosted runner executes whatever the workflow contains. This is
  fine for a private repo you control; do NOT enable it for untrusted forks/PRs.
