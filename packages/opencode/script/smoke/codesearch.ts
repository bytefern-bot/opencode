import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { CodeSearchTool } from "../../src/tool/codesearch"
import * as Truncate from "../../src/tool/truncate"
import * as Tool from "../../src/tool/tool"

const started = Date.now()
const step = (message: string, data?: Record<string, unknown>) => {
  const elapsed = `${Date.now() - started}ms`.padStart(7)
  console.log(`[codesearch-smoke +${elapsed}] ${message}`)
  if (data) console.log(JSON.stringify(data, null, 2))
}

function usage() {
  console.log(`Usage:
  bun run --conditions=browser script/smoke/codesearch.ts [--tokens=3000] "query"

Examples:
  EXA_API_KEY=... bun run --conditions=browser script/smoke/codesearch.ts "Next.js partial prerendering configuration"
  bun run --conditions=browser script/smoke/codesearch.ts --tokens=1500 "Effect HttpClient post JSON"
`)
}

const args = process.argv.slice(2)
step("raw argv parsed", { args })
if (args.includes("--help") || args.includes("-h")) {
  usage()
  process.exit(0)
}

const tokensNum = Number(args.find((arg) => arg.startsWith("--tokens="))?.slice("--tokens=".length) ?? 3000)
const query = args.filter((arg) => !arg.startsWith("--tokens=")).join(" ").trim()
step("normalized input", {
  query,
  tokensNum,
  hasExaApiKey: Boolean(process.env.EXA_API_KEY),
  exaMcpUrl: process.env.EXA_MCP_URL ?? "(default)",
})

if (!query) {
  usage()
  process.exit(1)
}

step("building mock Agent layer")
const agentLayer = Layer.succeed(
  Agent.Service,
  Agent.Service.of({
    get: () =>
      Effect.succeed({
        name: "build",
        mode: "primary",
        permission: [],
        options: {},
      } as Agent.Info),
    list: () => Effect.succeed([]),
    defaultAgent: () => Effect.succeed("build"),
    generate: () => Effect.die(new Error("Agent.generate is not needed for this smoke script")),
  }),
)

step("building mock Truncate layer")
const truncateLayer = Layer.succeed(
  Truncate.Service,
  Truncate.Service.of({
    cleanup: () => Effect.void,
    write: () => Effect.succeed(""),
    limits: () => Effect.succeed({ maxLines: 2_000, maxBytes: 50 * 1024 }),
    output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  }),
)

const sessionID = SessionID.descending()
const messageID = MessageID.ascending()
step("building minimal Tool.Context", { sessionID, messageID, agent: "build" })

const ctx: Tool.Context = {
  sessionID,
  messageID,
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: (input) =>
    Effect.sync(() => {
      step("tool metadata update", input)
    }),
  ask: (input) =>
    Effect.sync(() => {
      step("permission auto-allow", {
        permission: input.permission,
        patterns: input.patterns,
        always: input.always,
        metadata: input.metadata,
      })
    }),
}

const program = Effect.gen(function* () {
  yield* Effect.sync(() => step("resolving CodeSearchTool service dependencies"))
  const info = yield* CodeSearchTool
  yield* Effect.sync(() => step("initializing tool wrapper", { id: info.id }))
  const tool = yield* Tool.init(info)
  yield* Effect.sync(() =>
    step("executing tool", {
      id: tool.id,
      query,
      tokensNum,
      descriptionChars: tool.description.length,
    }),
  )
  const result = yield* tool.execute({ query, tokensNum }, ctx)
  yield* Effect.sync(() =>
    step("tool finished", {
      title: result.title,
      outputChars: result.output.length,
      metadata: result.metadata,
    }),
  )
  return result
})

step("starting Effect runtime")
const result = await Effect.runPromise(
  program.pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(agentLayer), Effect.provide(truncateLayer)),
)

step("printing result")
console.log(`\n# ${result.title}\n`)
console.log(result.output)
