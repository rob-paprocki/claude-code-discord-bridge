# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-11-15

**Upgrading:** nothing to do.

### Changed

- The README's license badge now reads the license from GitHub, a last-commit badge sits beside it, and the setup check table says *When it works* instead of using a check-mark emoji.

## [0.1.0] - 2026-11-13

**Upgrading:** nothing to do; this is the first release.

### Added

- A Cloudflare Worker you deploy to your own account. It relays Claude Code permission prompts, questions and finished turns to your Discord DMs, from any session on any machine.
- A hook client (`hooks/bridge-hook.sh`) and a ready-made `examples/settings-hooks.json` to install on each machine. If the Worker cannot be reached, Claude Code shows its normal terminal prompt.
- A **Deploy to Cloudflare** button. It asks only for the bot token.
- `BRIDGE_QUESTIONS=notify`: Claude's questions arrive as a one-way DM and show in the terminal and Claude Code's Remote Control straight away, instead of waiting for an answer in Discord.
- Permission DMs offer the terminal's other choices: **Always allow**, when Claude Code suggests a "don't ask again" rule (the DM says what it covers, and the rule Claude Code proposed is applied), and **Switch to auto mode**.
- The Worker sets itself up from the bot token. It finds the application, its public key and its owner, sets an empty Interactions Endpoint URL to itself, and registers `/machines`. Deploying needs one secret, `DISCORD_BOT_TOKEN`; `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY` and `ALLOWED_USER_IDS` are optional overrides.
- A status page at the Worker's address. It shows what's set up and what to fix, sends you a test DM, and can move Discord's button presses to this address: it DMs you a link, and the move happens only once you confirm on the page it opens. When Discord refuses the address, the page says Cloudflare Access may be in the way.
- Permission prompts with Allow and Deny buttons.
- Questions with option buttons, select menus for questions that allow several answers, and **Answer…** and **Chat…** for your own text.
- Conversation mode: after you send your own text from Discord (**Answer…**, **Chat…** or **Reply…**), each turn end of that session sends Claude's full reply with a **Reply…** button, until you press **Back to terminal** or type a prompt in that session.
- "Done" DMs for turns that run longer than 6 minutes (`STOP_MINUTES` changes this), with a **Reply…** button that stays valid for 2 hours.
- One-way notices, without buttons, when a session stops with an error, when auto mode blocks a tool, or when a background session needs input.
- Release to the terminal: a waiting prompt goes back to the terminal when you press **Back to terminal**, or, on macOS, when you type or click while a terminal app is in front on that machine. Using Discord or any other app on the same Mac leaves the prompt waiting in Discord.
- Waiting prompts and questions expire after 24 hours, and the DM says so.
- When a request goes back to the terminal (by input, at the end of the turn, or by expiry), its DM keeps its text and loses its buttons.
- A permission prompt answered in the terminal or the Claude app clears the buttons from its DM once the command has run. The DM changes to "Back at the terminal."
- A request stays answerable until it expires, even when its hook hasn't polled for a long time. An answer sent from the phone while the Mac sleeps is applied when the hook next reaches the Worker, before any touch of the keyboard or mouse hands the prompt to the terminal. If the Worker can't be reached, the hook waits up to 2 minutes (`BRIDGE_GIVE_UP_SECONDS`) before it gives the prompt back to the terminal.
- `examples/settings-hooks.json` raises Claude Code's Stop-hook limit (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) to 100, so long Discord conversations are not cut off.
- Machines join with a code you approve in Discord, and each machine gets its own key. A join request stays open for 30 minutes, and the install script waits that long for you.
- Remove a machine from its join DM, or with the `/machines` command.
- `hooks/bridge-install.sh` sets a machine up (copies the hook client, merges the hook settings, joins the bridge), and `--leave` takes it out again.

[Unreleased]: https://github.com/rob-paprocki/claude-code-discord-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rob-paprocki/claude-code-discord-bridge/releases/tag/v0.1.0
