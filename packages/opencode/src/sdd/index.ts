import * as Core from "./core"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Context, Effect, Layer, Schema } from "effect"

export const Event = {
  ChangeCreated: EventV2.define({
    type: "sdd.change.created",
    schema: {
      changeName: Schema.String,
      schemaName: Schema.String,
      changeRoot: Schema.String,
    },
  }),
  ChangeUpdated: EventV2.define({
    type: "sdd.change.updated",
    schema: {
      changeName: Schema.String,
      schemaName: Schema.String,
      changeRoot: Schema.String,
    },
  }),
}

export interface Interface {
  readonly schemas: () => Effect.Effect<ReturnType<typeof Core.listSchemas>, Error>
  readonly validateSchema: (schema?: string) => Effect.Effect<ReturnType<typeof Core.validateSchema>, Error>
  readonly changes: () => Effect.Effect<ReturnType<typeof Core.listChanges>, Error>
  readonly createChange: (
    input: Parameters<typeof Core.createChange>[1],
  ) => Effect.Effect<ReturnType<typeof Core.createChange>, Error>
  readonly status: (change: string) => Effect.Effect<ReturnType<typeof Core.getStatus>, Error>
  readonly instructions: (
    change: string,
    artifact?: string,
  ) => Effect.Effect<ReturnType<typeof Core.getArtifactInstructions>, Error>
  readonly apply: (change: string) => Effect.Effect<ReturnType<typeof Core.getApplyInstructions>, Error>
  readonly snapshot: () => Effect.Effect<ReturnType<typeof Core.getSnapshot>, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Sdd") {}

function tryCore<T>(body: () => T): Effect.Effect<T, Error> {
  return Effect.try({
    try: body,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    function root() {
      return Effect.map(InstanceState.context, (ctx) => ctx.worktree)
    }

    const schemas: Interface["schemas"] = Effect.fn("Sdd.schemas")(function* () {
      const projectRoot = yield* root()
      return yield* tryCore(() => Core.listSchemas(projectRoot))
    })

    const validateSchema: Interface["validateSchema"] = Effect.fn("Sdd.validateSchema")(function* (schema) {
      const projectRoot = yield* root()
      return yield* tryCore(() => Core.validateSchema(projectRoot, schema))
    })

    const changes: Interface["changes"] = Effect.fn("Sdd.changes")(function* () {
      const projectRoot = yield* root()
      return yield* tryCore(() => Core.listChanges(projectRoot))
    })

    const createChange: Interface["createChange"] = Effect.fn("Sdd.createChange")(function* (input) {
      const projectRoot = yield* root()
      const result = yield* tryCore(() => Core.createChange(projectRoot, input))
      const event = {
        changeName: result.changeName,
        schemaName: result.schemaName,
        changeRoot: result.changeRoot,
      }
      yield* events.publish(Event.ChangeCreated, event)
      yield* events.publish(Event.ChangeUpdated, event)
      return result
    })

    const status: Interface["status"] = Effect.fn("Sdd.status")(function* (change) {
      const projectRoot = yield* root()
      return yield* tryCore(() => Core.getStatus(projectRoot, change))
    })

    const instructions: Interface["instructions"] = Effect.fn("Sdd.instructions")(function* (change, artifact) {
      const projectRoot = yield* root()
      return yield* tryCore(() => Core.getArtifactInstructions(projectRoot, change, artifact))
    })

    const apply: Interface["apply"] = Effect.fn("Sdd.apply")(function* (change) {
      const projectRoot = yield* root()
      return yield* tryCore(() => Core.getApplyInstructions(projectRoot, change))
    })

    const snapshot: Interface["snapshot"] = Effect.fn("Sdd.snapshot")(function* () {
      const projectRoot = yield* root()
      return yield* tryCore(() => Core.getSnapshot(projectRoot))
    })

    return Service.of({ schemas, validateSchema, changes, createChange, status, instructions, apply, snapshot })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer))

export * as SddCore from "./core"
export * as Sdd from "."
