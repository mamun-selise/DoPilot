#!/usr/bin/env node
// KORA CLI entry point. Installed from the DoPilot web app:
//   npm i -g --prefix "$env:USERPROFILE\.kora" https://<app-domain>/kora
import { login, logout } from "../lib/auth.js";
import { pkg, source } from "../lib/config.js";
import { init } from "../lib/init.js";
import { start } from "../lib/start.js";
import { status } from "../lib/status.js";
import { update } from "../lib/update.js";

const commands = {
  login: () => login(),
  logout: () => (logout(), console.log("Logged out.")),
  init: (args) => init(args),
  start: () => start(),
  status: () => status(),
  version: () => console.log(pkg.version),
  update: () => update(),
  help
};

const [command = "help", ...args] = process.argv.slice(2);
const run = commands[command.replace(/^--?/, "")];
if (!run) {
  console.error(`Unknown command: ${command}\n`);
  help();
  process.exit(1);
}
try {
  await run(args);
} catch (error) {
  console.error(`kora ${command}: ${error.message}`);
  process.exit(1);
}

function help() {
  console.log(`kora ${pkg.version}

Usage: kora <command>

Commands:
  login     Sign in with your Blocks account
  init      Create ~/.kora/runner.yml from your local FE/BE repositories
  start     Connect to the web app and run the tasks it sends
  status    Show login, runner.yml, Claude Code and backend status
  version   Print the installed version
  update    Install the latest version from ${source.url || "<source not set>"}
  logout    Sign out
  help      Show this help`);
}
