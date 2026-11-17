# KORA

Local runner that connects this machine's Claude Code to the DoPilot web app.

## Install

KORA installs into your user profile (`C:\Users\<you>\.kora` on Windows, `~/.kora` on macOS/Linux), never into the Node.js install folder, so no admin rights are needed.

Windows (PowerShell):

```powershell
npm i -g --prefix "$env:USERPROFILE\.kora" https://dbdlnp-esvbb.slsblx.com/kora
# once: put kora on your PATH, then open a new terminal
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:USERPROFILE\.kora", "User")
```

macOS / Linux:

```sh
npm i -g --prefix ~/.kora https://dbdlnp-esvbb.slsblx.com/kora
# once: add to your shell profile
export PATH="$HOME/.kora/bin:$PATH"
```

## Get started

```sh
kora login    # sign in with your Blocks account (approve the code in your browser)
kora init     # point KORA at your local FE/BE clones; writes ~/.kora/runner.yml
kora status   # check login, runner.yml, Claude Code and the backend
kora start    # go online; tasks sent from the web app run here with your Claude Code
```

`runner.yml` stays on this machine. Each task runs in its own git worktree under `~/.kora/worktrees`, on a
`kora/<task>` branch, never in your clones. Claude may only run the commands listed in `exec.allowBinaries`,
and only you can send tasks to your runner unless `dispatch.accept` lists other people.

The web app's **PRs** page lists, approves and merges pull requests through a runner, with the GitHub CLI on
that machine: install `gh` and run `gh auth login` there. Approvals and merges show as that `gh` account, and
the same `dispatch.accept` rule decides who may use them. Needs kora 0.2.3 or newer.

Repositories you don't have cloned (for example the one you deploy from) can be added from those pages with
**Add repository** (kora 0.2.6+). Your runner checks the repo with `gh` and saves it in `runner.yml` as a
GitHub-only entry, `name: { github: owner/name }`, with no `path`. Pull requests and settings work on it; tasks
need a clone, so they are refused. Only the runner's owner can add or remove these.

**Add repository → Local clone** (kora 0.2.7+) adds a clone that is already on this machine, the same way
`kora init` adds FE and BE: pick one of the git folders KORA finds next to your clones and in the usual code
folders, or type the path. It is saved as `key: { path, github }` and takes tasks too. Picking the clone of a
GitHub-only repository gives that entry its path.

**Release > Ready to stage** (kora 0.2.8+) is a board the web app keeps in Blocks Data (kora 0.2.12+; earlier
versions used GitHub labels), so moving cards changes nothing on GitHub. **Merge** runs a queue
on this runner: it merges the PRs one at a time and, after each, waits for every GitHub Actions run on the merge
commit to finish before the next, so each PR gets its own build and version. A failed build stops the queue. If
branch protection requires up-to-date branches, a PR left behind by the previous merge is updated and its checks
awaited first. Progress shows on the board and in the `kora start` window.

The `yml` repo in `runner.yml` (asked for by `kora init` after FE and BE) is the deployment repo (kora 0.2.10+): it
shows only on **Release > Deploy to stage** and **Deploy to prod**, which list its PRs whose title mentions
stage/staging or prod/production. FE, BE and every other repo show everywhere else. Any other repo can be made a
deployment repo with `deployment: true` (or **Deployment repo** / **Mark as deployment repo** in the web app), and
`deployment: false` on `yml` turns the default off.

**Release > Environments** (kora 0.2.11+) reads the deployment repo's `<service>/dev|stg|production/*.txt` image
lists (the last line is what runs) and shows, per service, what each environment runs and whether stage is behind or
ahead of dev, and prod of stage. **Promote** and **Rollback** open a deploy PR in the repo's usual format (e.g. branch
`webservice-stg-1992`, title `Webservice - Deploy to STAGE - v1.349.0`) that appends the chosen image line; merging it
runs that environment's deploy workflow. The runner re-reads the repo first and refuses stale or unknown images.

**Quick deploy** (kora 0.2.13+), at the top of Deploy to stage / Deploy to prod, lists the ticked services
(webservice, webhost and webclient by default) with the newest version (what dev runs) chosen; any version the service
has run anywhere can be picked instead. One button opens a deploy PR per service, and merges it when *Merge right away*
is ticked.

## Update

```sh
kora update
```

Installs the latest version into the same folder KORA is already in.
