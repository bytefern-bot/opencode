import { expect, test } from "bun:test"
import { Exit, Schema } from "effect"
import { UpdatePayload } from "../../src/server/routes/instance/httpapi/groups/session"

test("session update payload accepts null archived timestamp for unarchiving /btw forks", () => {
  const result = Schema.decodeUnknownExit(UpdatePayload)({ time: { archived: null } })
  expect(Exit.isSuccess(result)).toBe(true)
})
