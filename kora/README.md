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

## Update

```sh
kora update
```

Installs the latest version into the same folder KORA is already in.
