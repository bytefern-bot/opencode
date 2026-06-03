import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

const runtimeRoot = path.join(tmpdir(), "opencode-bus-smoke-runtime")
process.env.XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? path.join(runtimeRoot, "data")
process.env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME ?? path.join(runtimeRoot, "cache")
process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? path.join(runtimeRoot, "config")
process.env.XDG_STATE_HOME = process.env.XDG_STATE_HOME ?? path.join(runtimeRoot, "state")
process.env.OPENCODE_TEST_HOME = process.env.OPENCODE_TEST_HOME ?? path.join(runtimeRoot, "home")
process.env.OPENCODE_DB = process.env.OPENCODE_DB ?? ":memory:"

const started = Date.now()
const step = (message: string, data?: Record<string, unknown>) => {
  const elapsed = `${Date.now() - started}ms`.padStart(7)
  console.log(`[bus-smoke +${elapsed}] ${message}`)
  if (data) console.log(JSON.stringify(data, null, 2))
}

function usage() {
  console.log(`Usage:
  bun run script/smoke/bus.ts

What this verifies:
  - typed subscribers receive matching events
  - typed subscribers ignore other event types
  - subscribeAll receives every event
  - unsubscribe stops future delivery
  - separate Instance directories have isolated buses
  - publish also forwards a wrapped event through GlobalBus
  - disposing an instance emits server.instance.disposed
`)
}

function assert(name: string, condition: boolean, data?: Record<string, unknown>) {
  if (!condition) {
    step(`FAIL ${name}`, data)
    process.exit(1)
  }
  step(`PASS ${name}`, data)
}

function same<T>(left: T, right: T) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function makeDirectory(label: string) {
  return mkdtemp(path.join(tmpdir(), `opencode-bus-smoke-${label}-`))
}

function withInstance(directory: string, fn: () => Promise<void>) {
  return Instance.provide({ directory, fn })
}

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
  usage()
  process.exit(0)
}

const { Bus } = await import("../../src/bus")
const { GlobalBus } = await import("../../src/bus/global")
const { BusEvent } = await import("../../src/bus/bus-event")
const { Instance } = await import("../../src/project/instance")

const TestEvent = {
  Ping: BusEvent.define("smoke.bus.ping", Schema.Struct({ value: Schema.Number })),
  Pong: BusEvent.define("smoke.bus.pong", Schema.Struct({ message: Schema.String })),
}

const directoryA = await makeDirectory("a")
const directoryB = await makeDirectory("b")

step("created temporary instance directories", { directoryA, directoryB })

const globalEvents: Array<{ directory?: string; type: string }> = []
const globalHandler = (event: { directory?: string; payload: { type: string } }) => {
  if (!event.payload.type.startsWith("smoke.bus.") && event.payload.type !== Bus.InstanceDisposed.type) return
  globalEvents.push({ directory: event.directory, type: event.payload.type })
}

GlobalBus.on("event", globalHandler)

try {
  await withInstance(directoryA, async () => {
    step("subscribing inside instance A")

    const pings: number[] = []
    const all: string[] = []

    const unsubscribePing = Bus.subscribe(TestEvent.Ping, (event) => {
      step("typed subscriber received event", {
        type: event.type,
        value: event.properties.value,
      })
      pings.push(event.properties.value)
    })

    const unsubscribeAll = Bus.subscribeAll((event) => {
      if (!event.type.startsWith("smoke.bus.")) return
      step("wildcard subscriber received event", { type: event.type })
      all.push(event.type)
    })

    await Bus.publish(TestEvent.Pong, { message: "typed subscriber should ignore this" })
    await Bus.publish(TestEvent.Ping, { value: 1 })
    await Bus.publish(TestEvent.Ping, { value: 2 })
    await Bun.sleep(20)

    assert("typed subscriber only received ping values", same(pings, [1, 2]), { pings })
    assert(
      "subscribeAll received ping and pong event types",
      same(all, ["smoke.bus.pong", "smoke.bus.ping", "smoke.bus.ping"]),
      { all },
    )

    unsubscribePing()
    await Bun.sleep(10)
    await Bus.publish(TestEvent.Ping, { value: 3 })
    await Bun.sleep(20)

    assert("unsubscribe stopped typed subscriber", same(pings, [1, 2]), { pings })
    assert(
      "subscribeAll still received events after typed unsubscribe",
      same(all, ["smoke.bus.pong", "smoke.bus.ping", "smoke.bus.ping", "smoke.bus.ping"]),
      { all },
    )

    unsubscribeAll()
  })

  const isolatedA: number[] = []
  const isolatedB: number[] = []

  await withInstance(directoryA, async () => {
    Bus.subscribe(TestEvent.Ping, (event) => {
      isolatedA.push(event.properties.value)
    })
    await Bun.sleep(10)
  })

  await withInstance(directoryB, async () => {
    Bus.subscribe(TestEvent.Ping, (event) => {
      isolatedB.push(event.properties.value)
    })
    await Bun.sleep(10)
  })

  await withInstance(directoryA, async () => {
    await Bus.publish(TestEvent.Ping, { value: 10 })
    await Bun.sleep(20)
  })

  await withInstance(directoryB, async () => {
    await Bus.publish(TestEvent.Ping, { value: 20 })
    await Bun.sleep(20)
  })

  assert("instance A only received instance A event", same(isolatedA, [10]), { isolatedA })
  assert("instance B only received instance B event", same(isolatedB, [20]), { isolatedB })

  assert(
    "GlobalBus received wrapped smoke events with directories",
    globalEvents.some((event) => event.directory === directoryA && event.type === "smoke.bus.ping") &&
      globalEvents.some((event) => event.directory === directoryB && event.type === "smoke.bus.ping"),
    { globalEvents },
  )

  const disposed: string[] = []
  await withInstance(directoryA, async () => {
    Bus.subscribeAll((event) => {
      if (event.type === Bus.InstanceDisposed.type) disposed.push(event.properties.directory)
    })
    await Bun.sleep(10)
  })

  await Instance.disposeAll()
  await Bun.sleep(50)

  assert("dispose emitted server.instance.disposed to wildcard subscriber", disposed.includes(directoryA), { disposed })

  step("all bus smoke checks passed")
} finally {
  GlobalBus.off("event", globalHandler)
  await Instance.disposeAll()
}
