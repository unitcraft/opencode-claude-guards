# opencode-claude-guards

OpenCode V2 plugin: runs the **Claude Code rules of the session's repository** —
`.claude/settings.json` — inside OpenCode, which does not execute them by itself.

- `PreToolUse` hooks for shell commands: the same scripts; exit code 2 refuses the command
  with the hook's text;
- `permissions.deny`: `Read(...)` refuses reading by glob, `Bash(...)` / `PowerShell(...)`
  refuses a command by prefix (`git -C <path>` is stripped first, so `git -C . reset --hard`
  does not slip past `git reset --hard`);
- slash commands from `.claude/commands/*.md`, the template read at call time.

The repository is the git top level of the session's directory; where there is no
`.claude/settings.json` the plugin does nothing. The rules have one home — the settings file
is read on every call, no copy is kept.

Not covered (no exact OpenCode counterpart): `Write`, `Stop`, `SessionStart`, `PostToolUse`
hooks; Claude Code subagent definitions. A failure of the plugin itself lets the command
through (like Claude Code hooks) and is logged to `<tmp>/nova-opencode-plugins.log`.

## Install

```sh
git clone https://github.com/unitcraft/opencode-claude-guards D:/Sources/opencode-claude-guards
```

`~/.config/opencode/opencode.jsonc`:

```jsonc
"plugins": ["D:/Sources/opencode-claude-guards"]
```

History: moved with its commits from `nv-lang/nova-opencode-plugins` (`plugins/nova-guards`).
