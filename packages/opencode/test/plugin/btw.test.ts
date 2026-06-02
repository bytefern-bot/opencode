import { expect, test } from "bun:test"
import { BtwPlugin } from "../../src/plugin/btw"

test("BtwPlugin registers and handles /btw command", async () => {
  const calls: Array<{ path: { id: string }; body: { question: string } }> = []
  const plugin = await BtwPlugin({
    client: {
      session: {
        btw: async (input: { path: { id: string }; body: { question: string } }) => {
          calls.push(input)
          return { data: { sessionID: "ses_btw", message: "Started /btw side question." } }
        },
      },
    },
  } as Parameters<typeof BtwPlugin>[0])

  const config: { command: Record<string, { description: string; template: string }> } = { command: {} }
  await plugin.config?.(config as Parameters<NonNullable<typeof plugin.config>>[0])
  expect(config.command.btw).toEqual({
    description: "ask a side question in a background fork",
    template: "$ARGUMENTS",
  })

  const output: {
    parts: []
    handled?: {
      message?: string
      metadata?: Record<string, unknown>
    }
  } = { parts: [] }
  await plugin["command.execute.before"]?.(
    { command: "btw", sessionID: "ses_parent", arguments: " hello " },
    output,
  )

  expect(calls).toEqual([{ path: { id: "ses_parent" }, body: { question: "hello" } }])
  expect(output.handled).toEqual({
    message: "Started /btw side question.",
    metadata: {
      kind: "btw",
      sessionID: "ses_btw",
      question: "hello",
    },
  })
})
