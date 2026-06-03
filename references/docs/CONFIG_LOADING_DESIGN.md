# opencode configuration loading design

This document explains how opencode loads configuration files, why the loading
mechanism is layered, and how different configuration sources interact.

The implementation is centered around:

- `src/config/config.ts`: main config service, schema, merge order, cache, update
  logic.
- `src/config/paths.ts`: config file and config directory discovery.
- `src/config/parse.ts`: JSONC parsing and schema validation.
- `src/config/variable.ts`: `{env:VAR}` and `{file:path}` substitution.
- `src/config/managed.ts`: enterprise or system managed configuration.

## Goals

opencode's configuration system is designed as a multi-source, layered
configuration pipeline instead of a single-file reader.

The main goals are:

- Allow user-wide defaults, project defaults, and directory-local overrides to
  coexist.
- Let repositories version their own opencode behavior.
- Let monorepos define local behavior for specific packages or subtrees.
- Support directory-based extensions such as commands, agents, and plugins.
- Support JSONC so humans can write comments and trailing commas.
- Support secrets through environment variables and external files.
- Let SDKs inject config without writing a file.
- Let organizations enforce configuration through managed config.
- Keep runtime behavior consistent by caching resolved config per instance and
  reloading through instance disposal.

## Main concepts

### Config file

A config file is a JSON or JSONC file named `opencode.json`,
`opencode.jsonc`, or in one legacy global case, `config.json`.

Example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "github-copilot/gpt-5",
  "small_model": "openai/gpt-4.1-mini",
  "share": "manual",
  "instructions": ["./AGENTS.md"],
  "permission": {
    "bash": "ask",
    "edit": "allow"
  }
}
```

### Config directory

A config directory is a directory that can contain both config files and
directory-based extensions.

Typical examples:

```txt
~/.config/opencode/
repo/.opencode/
/path/from/OPENCODE_CONFIG_DIR/
```

Config directories may contain:

```txt
opencode.json
opencode.jsonc
command/
agent/
mode/
plugin/
plugins/
```

### Instance config

`Config.Service.get()` returns the resolved config for the current opencode
instance. It is loaded lazily through `InstanceState`, then cached for that
instance.

Calling `Config.invalidate()` clears the global config cache, disposes all
instances, and causes config to be recomputed on the next access.

## Parsing pipeline

Each config text goes through the same basic pipeline.

1. Read the file or virtual config string.
2. Substitute variables with `ConfigVariable.substitute()`.
3. Parse as JSONC with `jsonc-parser`.
4. Normalize legacy fields.
5. Validate against `Config.Info`.
6. Resolve path-like plugin specs while the source file path is still known.
7. If a file has no `$schema`, add `https://opencode.ai/config.json` and try to
   write it back.

### Variable substitution

Config text supports two substitutions:

```jsonc
{
  "username": "{env:USER}",
  "provider": {
    "custom": {
      "options": {
        "apiKey": "{file:./secret.txt}"
      }
    }
  }
}
```

`{env:VAR}` is replaced with `process.env.VAR` or an empty string.

`{file:path}` reads and trims the referenced file. Relative paths are resolved
relative to the config file directory. `~/` is expanded to the user's home
directory.

In JSONC line comments, `{file:...}` is intentionally ignored:

```jsonc
{
  // "{file:./example.txt}" is not expanded here.
  "username": "{env:USER}"
}
```

### JSONC support

Config files are parsed as JSONC. This allows comments and trailing commas:

```jsonc
{
  // Team default model.
  "model": "github-copilot/gpt-5",
  "instructions": [
    "./AGENTS.md",
  ],
}
```

### Schema validation

After parsing, config is validated against `Config.Info`.

Top-level unknown keys are rejected. For example, this should fail because
`modle` is misspelled:

```json
{
  "modle": "openai/gpt-5"
}
```

The reason for rejecting unknown top-level keys is to surface mistakes early.
Otherwise a typo can silently produce surprising runtime behavior.

### Legacy TUI fields

The main opencode config strips these legacy TUI fields:

```txt
theme
keybinds
tui
```

They should live in `tui.json` or `tui.jsonc` instead. The loader removes them
from main config and logs a warning.

## Config sources

### Global config

Global config is read from `Global.Path.config`.

The global loader reads these files in order:

```txt
config.json
opencode.json
opencode.jsonc
```

Later files override earlier files.

Example:

```txt
~/.config/opencode/
  config.json
  opencode.json
  opencode.jsonc
```

If both `opencode.json` and `opencode.jsonc` define `model`,
`opencode.jsonc` wins.

Example global config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4",
  "small_model": "openai/gpt-4.1-mini",
  "instructions": ["~/rules/personal.md"],
  "permission": {
    "bash": "ask",
    "edit": "allow"
  }
}
```

### Project config

Project config is discovered by walking upward from the current directory until
the worktree boundary.

Targets:

```txt
opencode.jsonc
opencode.json
```

The discovered files are reversed before loading. This makes project config
root-first, so deeper config overrides parent config.

Example:

```txt
repo/
  opencode.json
  packages/api/
    opencode.jsonc
```

If opencode starts in `repo/packages/api`, the effective order is:

```txt
repo/opencode.json
repo/packages/api/opencode.jsonc
```

Project config can be disabled with:

```bash
OPENCODE_DISABLE_PROJECT_CONFIG=true
```

When this flag is enabled, project `opencode.json/jsonc` files and project
`.opencode` directories are skipped. `OPENCODE_CONFIG_DIR` still works.

### `.opencode` directories

`ConfigPaths.directories()` returns a list of config directories:

```txt
Global.Path.config
project .opencode directories found while walking upward
home .opencode
OPENCODE_CONFIG_DIR
```

For each directory that ends in `.opencode`, and for `OPENCODE_CONFIG_DIR`, the
loader reads:

```txt
opencode.json
opencode.jsonc
```

The same directory is also scanned for commands, agents, modes, and plugins.

Example:

```txt
repo/
  .opencode/
    opencode.jsonc
    command/
      review.md
      release-notes.md
    agent/
      backend.md
    plugin/
      team-plugin.ts
```

Example `.opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["./team-rules.md"],
  "plugin": ["./plugin/team-plugin.ts"]
}
```

### `OPENCODE_CONFIG`

`OPENCODE_CONFIG` points at a custom config file:

```bash
OPENCODE_CONFIG=/path/to/work-profile.jsonc opencode
```

It is loaded after global config and before project config.

This is useful for a single-file profile:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/gpt-5",
  "disabled_providers": ["experimental-provider"]
}
```

### `OPENCODE_CONFIG_DIR`

`OPENCODE_CONFIG_DIR` points at a whole config directory:

```bash
OPENCODE_CONFIG_DIR=/path/to/profile opencode
```

The directory can contain:

```txt
opencode.json
opencode.jsonc
command/
agent/
mode/
plugin/
plugins/
```

This is useful when a profile includes not only structured JSON settings but
also command, agent, and plugin files.

Example:

```txt
profiles/work/
  opencode.jsonc
  command/
    jira.md
  agent/
    reviewer.md
```

### `OPENCODE_CONFIG_CONTENT`

`OPENCODE_CONFIG_CONTENT` contains inline JSON or JSONC config:

```bash
OPENCODE_CONFIG_CONTENT='{"model":"openai/gpt-5","username":"ci"}' opencode
```

It is treated as a virtual local config whose base directory is the instance
directory.

The JavaScript SDK uses this mechanism to inject config into child processes
without creating temporary config files.

Example with substitution:

```bash
OPENCODE_CONFIG_CONTENT='{"username":"{env:USER}"}' opencode
```

### Remote well-known config

If auth contains an entry with `type === "wellknown"`, the loader fetches:

```txt
<url>/.well-known/opencode
```

The response is expected to contain a `config` object.

This allows a remote account or provider to publish defaults.

### Console active organization config

If there is an active account with an active organization, opencode tries to
load organization config from the account service.

This config is merged after `OPENCODE_CONFIG_CONTENT` and before managed config.
Provider IDs from this source are tracked in console state as managed providers.

### Managed config directory

Managed config is intended for enterprise or system administration.

The directory is platform-specific:

```txt
macOS:   /Library/Application Support/opencode
Windows: %ProgramData%/opencode
Linux:   /etc/opencode
```

The loader reads:

```txt
opencode.json
opencode.jsonc
```

Managed config is loaded near the end, so it overrides user and project config.

Example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "enterprise": {
    "url": "https://opencode.company.com"
  },
  "permission": {
    "bash": "ask"
  }
}
```

### macOS managed preferences

On macOS, opencode also reads MDM-managed preferences:

```txt
/Library/Managed Preferences/<user>/ai.opencode.managed.plist
/Library/Managed Preferences/ai.opencode.managed.plist
```

These are converted with `plutil`, stripped of mobileconfig metadata keys, and
loaded as config JSON.

This source overrides everything else.

## Merge order

The effective main config load order is:

```txt
1. Remote well-known config
2. Global config
3. OPENCODE_CONFIG
4. Project opencode.json/jsonc files
5. Config directories:
   - .opencode/opencode.json
   - .opencode/opencode.jsonc
   - OPENCODE_CONFIG_DIR/opencode.json
   - OPENCODE_CONFIG_DIR/opencode.jsonc
   - command, agent, mode, plugin directory loading
6. OPENCODE_CONFIG_CONTENT
7. Console active organization config
8. Managed config directory
9. macOS MDM managed preferences
10. Runtime compatibility transforms and flags
```

Later sources generally override earlier sources.

## Merge semantics

### Objects are deep-merged

Example global config:

```json
{
  "permission": {
    "bash": "ask",
    "edit": "deny"
  }
}
```

Example project config:

```json
{
  "permission": {
    "edit": "allow"
  }
}
```

Effective config:

```json
{
  "permission": {
    "bash": "ask",
    "edit": "allow"
  }
}
```

### Scalars are overwritten

Example global config:

```json
{
  "model": "anthropic/claude-sonnet-4"
}
```

Example project config:

```json
{
  "model": "github-copilot/gpt-5"
}
```

Effective config:

```json
{
  "model": "github-copilot/gpt-5"
}
```

### `instructions` are appended and deduplicated

`instructions` are special. They are not replaced. They are appended and
deduplicated.

Example global config:

```json
{
  "instructions": ["global.md", "shared.md"]
}
```

Example project config:

```json
{
  "instructions": ["project.md", "shared.md"]
}
```

Effective config:

```json
{
  "instructions": ["global.md", "shared.md", "project.md"]
}
```

This behavior lets global personal rules, team rules, and directory-local rules
stack together.

### Plugins keep origin metadata

User-facing config stores `plugin` as a list of specs. During loading, opencode
also derives `plugin_origins`, which records:

- the winning plugin spec,
- the source file or directory,
- whether it is global or local.

This is needed because plugin paths are location-sensitive. A plugin declared as
`"./plugin.ts"` should be resolved relative to the file that declared it, not
relative to some later merged config location.

Plugins are deduplicated by plugin identity while retaining the winning origin
metadata.

## Compatibility transforms

### `mode` to `agent`

The legacy `mode` field is merged into `agent`.

Each `mode` entry becomes a primary agent:

```jsonc
{
  "mode": {
    "review": {
      "prompt": "Review the code."
    }
  }
}
```

Becomes conceptually:

```jsonc
{
  "agent": {
    "review": {
      "prompt": "Review the code.",
      "mode": "primary"
    }
  }
}
```

### `autoshare` to `share`

If `autoshare` is `true` and `share` is not set, `share` becomes `"auto"`.

### `tools` to `permission`

The legacy `tools` field is converted into permission rules.

Example:

```json
{
  "tools": {
    "bash": false,
    "write": true
  }
}
```

Becomes conceptually:

```json
{
  "permission": {
    "bash": "deny",
    "edit": "allow"
  }
}
```

`write`, `edit`, and `patch` all map to `edit`.

### Runtime flags

Some runtime flags modify final config after file loading:

```txt
OPENCODE_PERMISSION
OPENCODE_DISABLE_AUTOCOMPACT
OPENCODE_DISABLE_PRUNE
```

For example, `OPENCODE_DISABLE_AUTOCOMPACT` sets:

```json
{
  "compaction": {
    "auto": false
  }
}
```

## Update behavior

### `Config.update()`

`Config.update()` writes to the current instance directory:

```txt
<instance-directory>/config.json
```

It loads existing `config.json`, deep-merges the writable config, writes the
result, and disposes the current instance unless `dispose: false` is passed.

This is used for instance-scoped updates.

### `Config.updateGlobal()`

`Config.updateGlobal()` writes to the global config file.

The selected global file is:

```txt
opencode.jsonc if it exists
opencode.json if it exists
config.json if it exists
opencode.jsonc otherwise
```

For JSON files, it writes formatted JSON. For JSONC files, it uses
`jsonc-parser` edits so existing comments and formatting are more likely to be
preserved.

After writing, it invalidates config so future reads reload.

## Cache and reload model

Config is not read from disk on every access.

There are two relevant cache layers:

- Global config is cached with an infinite TTL until invalidated.
- Instance config is cached by `InstanceState`.

`Config.invalidate()` does three things:

1. Invalidates the global config cache.
2. Disposes all instances.
3. Emits a global disposed event.

The next `Config.Service.get()` recomputes the resolved config.

This design keeps consumers simple. Most services can read config from
`Config.Service.get()` and rely on instance lifecycle to handle reloads, instead
of each service having its own file watcher or partial reload logic.

## End-to-end example

Consider this layout:

```txt
~/.config/opencode/
  opencode.jsonc

repo/
  opencode.jsonc
  AGENTS.md
  .opencode/
    opencode.jsonc
    team-rules.md
    command/
      review.md
    agent/
      backend.md
    plugin/
      team-plugin.ts

/etc/opencode/
  opencode.json
```

Global config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4",
  "small_model": "openai/gpt-4.1-mini",
  "instructions": ["~/rules/personal.md"],
  "permission": {
    "bash": "ask",
    "edit": "allow"
  }
}
```

Project config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "github-copilot/gpt-5",
  "instructions": ["./AGENTS.md"],
  "mcp": {
    "linear": {
      "type": "local",
      "command": ["bun", "run", "./scripts/mcp-linear.ts"]
    }
  }
}
```

`.opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["./team-rules.md"],
  "plugin": ["./plugin/team-plugin.ts"],
  "agent": {
    "backend": {
      "description": "Backend implementation agent",
      "prompt": "{file:./agent/backend.md}",
      "mode": "subagent"
    }
  }
}
```

Managed config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "enterprise": {
    "url": "https://opencode.company.com"
  },
  "permission": {
    "bash": "ask"
  }
}
```

The effective config is conceptually:

```jsonc
{
  "model": "github-copilot/gpt-5",
  "small_model": "openai/gpt-4.1-mini",
  "instructions": [
    "~/rules/personal.md",
    "./AGENTS.md",
    "./team-rules.md"
  ],
  "permission": {
    "bash": "ask",
    "edit": "allow"
  },
  "enterprise": {
    "url": "https://opencode.company.com"
  },
  "mcp": {
    "linear": {
      "type": "local",
      "command": ["bun", "run", "./scripts/mcp-linear.ts"]
    }
  },
  "plugin": ["file:///.../repo/.opencode/plugin/team-plugin.ts"],
  "agent": {
    "backend": {
      "description": "Backend implementation agent",
      "prompt": "...contents of backend.md...",
      "mode": "subagent"
    }
  }
}
```

Important details:

- `model` comes from the project because project config overrides global config.
- `small_model` remains from global config because project config does not set
  it.
- `instructions` from global, project, and `.opencode` are appended.
- `enterprise.url` comes from managed config.
- `permission.bash` is enforced by managed config.
- The plugin path is resolved relative to `.opencode/opencode.jsonc`.
- The agent prompt uses `{file:./agent/backend.md}` relative to
  `.opencode/opencode.jsonc`.

## Why this design is useful

### It matches how developers work

Developers often need personal defaults and project-specific rules at the same
time. A single global config would make repositories hard to share. A single
project config would make personal defaults repetitive. Layering solves both.

### It supports monorepos

In a monorepo, `packages/api` and `packages/web` may need different agents,
commands, instructions, or MCP servers. Walking upward and loading root-first
lets broad repo defaults apply first, then package-specific config override
them.

### It keeps extension files maintainable

Commands, agents, and plugins are easier to maintain as files in directories
than as large JSON strings. The config directory abstraction lets opencode
combine structured config with file-based extensions.

### It supports enterprise controls

Managed config being loaded last gives administrators a clear enforcement
point. This is important for provider routing, enterprise URLs, and permission
policy.

### It supports SDKs and subprocesses

`OPENCODE_CONFIG_CONTENT` avoids temporary files and lets SDKs use the exact
same parser, schema validation, and merge behavior as CLI usage.

### It centralizes reload behavior

By tying config reload to instance disposal, the system avoids many partial
reload edge cases. Services do not each need bespoke file watching and cache
invalidation logic.

## Operational notes

Use this command to inspect resolved config:

```bash
opencode debug config
```

When changing config-related implementation, useful areas to inspect are:

```txt
packages/opencode/src/config/config.ts
packages/opencode/src/config/paths.ts
packages/opencode/src/config/parse.ts
packages/opencode/src/config/variable.ts
packages/opencode/src/config/managed.ts
packages/opencode/test/config/config.test.ts
```

Run type checks from the package directory:

```bash
cd packages/opencode
bun typecheck
```

Tests should also be run from package directories, not from the repo root.
