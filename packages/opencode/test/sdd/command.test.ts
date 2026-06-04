import { describe, expect } from "bun:test"
import { Command } from "../../src/command"
import { testEffect } from "../lib/effect"
import { Effect } from "effect"

const it = testEffect(Command.defaultLayer)

describe("sdd commands", () => {
  it.instance("appear in Command.Service.list()", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const commands = yield* command.list()
      const names = commands.map((command) => command.name)
      expect(names).toContain("sdd-new")
      expect(names).toContain("sdd-next")
      expect(names).toContain("sdd-status")
      expect(names).toContain("sdd-apply")
    }),
  )
})
