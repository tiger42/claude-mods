# claude-mods

Personal [Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview), packaged as a plugin marketplace named `local-mods`.

Requires Claude Code 2.1.287 or later.

## Setup

```bash
git clone https://github.com/tiger42/claude-mods.git ~/claude-mods
claude plugin marketplace add ~/claude-mods
```

The marketplace is a local folder, so Claude Code reads each mod straight from the clone. To update: `git pull`, then `/reload-plugins` in any open session.

## Enable a mod

```bash
claude plugin install <mod>@local-mods --scope user     # all projects
claude plugin install <mod>@local-mods --scope project  # this repo, via .claude/settings.json
claude plugin disable <mod>@local-mods                  # turn off again
```

Or use `/plugin` in a session. Run `/reload-plugins` to load a mod into a session that is already open.

## Mods

### usage-band

![usage-band: 5-hour and weekly limit bars above the prompt](images/usage-band.png)

Band above the prompt showing the 5-hour and weekly rate limits of a Claude subscription. Each limit gets a gradient bar, a white tick for the time elapsed in the window, a countdown to the reset and a forecast at the current rate (`→ ~75% at reset` or `▲ full in 40m`). A light sweeps the bars while Claude works. A new session starts from the last reading of any other session. Collapse the band with `ctrl+x ctrl+a`.

Draws in the terminal and in the Desktop app's Code tab. Shows nothing for API-key accounts, which have no rate-limit windows.

```bash
claude plugin install usage-band@local-mods --scope user
```

## Development

```bash
claude --plugin-dir ./<mod>      # load a working copy, hot-reloads on save
claude plugin validate ./<mod>   # manifest and static analysis of the hooks module
claude plugin test ./<mod>       # runs <mod>/tests/*.test.ts(x)
```

`--plugin-dir` writes type declarations to `<mod>/.claude-plugin/types/` (git-ignored). Type-checking needs TypeScript 5.4 or later.

To add a mod, create its folder, list it under `plugins` in `.claude-plugin/marketplace.json` and add a section above.

## License

[MIT](LICENSE)
