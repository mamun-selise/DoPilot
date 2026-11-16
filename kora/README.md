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

## Update

```sh
kora update
```

Installs the latest version into the same folder KORA is already in.
