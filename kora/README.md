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

## Update

```sh
kora update
```

Installs the latest version into the same folder KORA is already in.
