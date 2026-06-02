# /btw Side Questions

This document describes the current `/btw` side-question implementation on this
branch compared with `dev`.

## Background

`dev` does not have a dedicated side-question flow. A slash command either
executes as a normal prompt command or falls through into the current session's
message stream. There is no built-in way to ask an incidental question, keep the
answer out of the main conversation, and optionally continue from that answer in
a separate session.

This branch adds `/btw` with the following behavior:

- `/btw <question>` asks a question against a fork of the current session.
- The fork runs in the background and is hidden from the normal child-session
  list while it is only being used as a side question.
- The TUI opens a modal that streams/polls the fork answer and keeps a local
  history for the current prompt view.
- Pressing `f` from the modal unarchives the fork and navigates to it.
- The main session records only a synthetic command result with metadata, not
  the side-question answer itself.

## Goals

- Match the Claude Code `/btw` user model: ask an aside without contaminating
  the active conversation.
- Reuse opencode plugin hooks for command registration and command handling.
- Keep source edits small and clearly marked with `#region btw` where existing
  core files are changed for this feature.
- Preserve an escape hatch from side question to real work by allowing users to
  fork into the side-question session.

## Non-Goals

- `/btw` is not a fully in-memory question runner. The implementation uses a
  normal forked session so existing session prompt, model, storage, and TUI
  polling code can be reused.
- `/btw` does not add a general-purpose ephemeral session abstraction.
- `/btw` does not expose side-question history as durable state on the parent
  session beyond the synthetic command result metadata.

## Implementation Compared With `dev`

### Plugin Command Entry

`dev` has no internal `/btw` plugin.

This branch adds `packages/opencode/src/plugin/btw.ts` and registers it from
`packages/opencode/src/plugin/index.ts`. The plugin contributes a command named
`btw` and handles `/btw` through the existing `command.execute.before` hook.

The hook calls the new session API endpoint through the SDK:

```ts
input.client.session.btw({
  path: { id: input.sessionID },
  body: { question: input.args },
})
```

Instead of letting the slash command continue as a normal assistant prompt, the
plugin returns a handled result with metadata:

```ts
{
  kind: "btw",
  sessionID: response.data.sessionID,
  question: input.args,
}
```

### Plugin Hook Contract

`dev` only supports a boolean-style command interception result.

This branch extends `packages/plugin/src/index.ts` so
`command.execute.before` can return handled metadata:

```ts
handled: true | { message?: string; metadata?: Record<string, unknown> }
```

`packages/opencode/src/session/prompt.ts` writes that metadata onto the
synthetic text part created for the intercepted command. This keeps the TUI
integration generic: the prompt component does not need to special-case the
literal `/btw` command dispatch path.

### HTTP API

`dev` has no `/session/:id/btw` endpoint.

This branch adds:

- `POST /session/{id}/btw`
- request body: `{ question: string }`
- response body: `{ sessionID: string }`

The handler in
`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
forks the current session, archives the fork immediately, and starts a prompt
against the fork.

The side prompt passes the question as user text and adds side-question
constraints through the prompt `system` option. Tools are disabled with:

```ts
tools: { "*": false }
```

That means the side question can answer from current context, but it should not
execute tools while the parent session is continuing.

### Session Prompt Runtime

`dev` resolves available tools for normal prompt execution.

This branch adds `disablesAllTools()` in
`packages/opencode/src/session/prompt.ts`. When the last user message disables
all tools with `"*": false`, prompt execution skips `SessionTools.resolve`.
This avoids unnecessary tool setup for `/btw` fork prompts and makes the
tool-disable semantics explicit.

The prompt runtime also includes caller-provided `system` text in the system
prompt array. The `/btw` endpoint uses that to apply side-question constraints
without placing internal instructions inside visible user text.

### Hidden Fork Sessions

`dev` shows child sessions based on parent relationship alone.

This branch marks `/btw` forks as archived on creation and filters archived
children from `Session.children(parentID)`. The fork still exists and can be
polled by ID, but it does not appear in the normal child-session list.

When the user presses `f` in the modal, the TUI calls session update with:

```ts
time: { archived: null }
```

The update payload accepts `null` for `time.archived`, and the handler maps that
to an unarchive operation before navigating to the fork.

### TUI Flow

`dev` has no `/btw` dialog.

This branch adds
`packages/opencode/src/cli/cmd/tui/component/dialog-btw.tsx`.

The prompt component still dispatches slash commands through the session command
API. After command execution, it inspects the synthetic command result metadata.
When `metadata.kind === "btw"`, it opens the modal with the returned fork
session ID and original question.

The modal:

- polls messages from the fork session;
- renders answer text;
- strips raw tool-call markup from displayed assistant text;
- supports dismiss, clear, scroll, and fork actions;
- stores a local prompt-view history of previous side questions.

This keeps `/btw` visually separate from the main transcript while preserving a
direct route to the underlying fork session.

### SDK Surface

`dev` has no SDK method for this endpoint.

This branch regenerates SDK files for both v1 and v2 session clients. The v2
types also allow `SessionUpdateData.body.time.archived` to be `number | null`
so TUI code can unarchive a hidden fork through the public session update API.

## End-to-End Flow

1. User enters `/btw why is this failing?` in the TUI.
2. The prompt component sends the slash command through `session.command`.
3. The internal `/btw` plugin intercepts the command in
   `command.execute.before`.
4. The plugin calls `POST /session/{id}/btw`.
5. The server forks the current session, archives the fork, and starts a prompt
   in the fork with all tools disabled.
6. The plugin returns handled metadata containing the fork session ID.
7. The prompt runtime stores that metadata on a synthetic command-result part.
8. The TUI reads the metadata and opens `DialogBtw`.
9. The dialog polls the fork messages and displays the side-question answer.
10. If the user presses `f`, the fork is unarchived and the TUI navigates to it.

## User-Visible Behavior

The main transcript should show the command invocation, but it should not show
the fork answer or internal prompt details as normal assistant output. The modal
is the only intended surface for the side-question response until the user forks
into the archived session.

The screenshot issue where raw `<tool_call>` content appears in the modal is
addressed by filtering raw tool-call XML-like blocks from the dialog text. The
more important prevention is disabling tools for the fork prompt so new `/btw`
answers should not generate tool calls in the first place.

## Testing

This branch adds or updates tests for the main behavior boundaries:

- `packages/opencode/test/plugin/btw.test.ts`
  - verifies command registration;
  - verifies command handling calls `session.btw`;
  - verifies handled metadata is returned.
- `packages/opencode/test/session/prompt.test.ts`
  - verifies `"*": false` disables all tools.
- `packages/opencode/test/server/session-btw.test.ts`
  - verifies session update payload accepts `time.archived: null`.
- `packages/opencode/test/session/session.test.ts`
  - verifies archived child sessions are hidden from child listing.

Validation run from package directories:

- `bun typecheck` in `packages/opencode`
- `bun typecheck` in `packages/plugin`
- `bun typecheck` in `packages/sdk/js`
- targeted `bun test` in `packages/opencode` for the `/btw` plugin, prompt,
  server payload, and session child-list tests

## Tradeoffs

- The hidden fork is still persisted. This keeps the implementation small and
  compatible with existing session APIs, but it is not a true transient
  side-channel.
- The TUI uses command-result metadata as the bridge from plugin hook to modal.
  This avoids a hardcoded `/btw` dispatch path in the prompt component, but it
  means plugin handled metadata is now part of the practical hook contract.
- Tool-call filtering in the dialog is a display guard. Correct behavior still
  depends on the fork prompt disabling tools and the model following the
  side-question system constraints.
