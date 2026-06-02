import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useBindings } from "../keymap"

type BtwPart = {
  type: string
  text?: string
  synthetic?: boolean
}

type BtwMessage = {
  info: {
    role: string
    time?: {
      completed?: number
    }
  }
  parts: BtwPart[]
}

type BtwHistoryItem = {
  sessionID: string
  parentSessionID: string
  question: string
  time: number
}

const history: BtwHistoryItem[] = []

export function DialogBtw(props: BtwHistoryItem) {
  const dialog = useDialog()
  const route = useRoute()
  const sdk = useSDK()
  const { theme } = useTheme()
  const [answer, setAnswer] = createSignal("Waiting for /btw answer...")
  const [loading, setLoading] = createSignal(true)
  const [offset, setOffset] = createSignal(0)
  const [historyVersion, setHistoryVersion] = createSignal(0)
  const lines = createMemo(() => answer().split("\n"))
  const visible = createMemo(() => lines().slice(offset(), offset() + 12))
  const visibleHistory = createMemo(() => {
    historyVersion()
    return history.slice(0, 5)
  })

  async function refresh() {
    const result = await sdk.client.session.messages({ sessionID: props.sessionID, limit: 50 })
    const messages = (result.data ?? []) as BtwMessage[]
    const assistant = messages.findLast((message) => message.info.role === "assistant")
    const text = assistant?.parts
      .filter((part) => part.type === "text" && !part.synthetic && part.text)
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text) setAnswer(text)
    if (assistant?.info.time?.completed) setLoading(false)
  }

  onMount(() => {
    if (!history.some((item) => item.sessionID === props.sessionID)) {
      history.unshift({ ...props, time: Date.now() })
      setHistoryVersion((value) => value + 1)
    }
    void refresh()
    const timer = setInterval(() => {
      if (loading()) void refresh()
    }, 1500)
    onCleanup(() => clearInterval(timer))
  })

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "Close /btw answer",
        group: "Dialog",
        cmd: () => dialog.clear(),
      },
      {
        key: "space",
        desc: "Close /btw answer",
        group: "Dialog",
        cmd: () => dialog.clear(),
      },
      {
        key: "down",
        desc: "Scroll /btw answer down",
        group: "Dialog",
        cmd: () => setOffset(Math.min(Math.max(0, lines().length - 12), offset() + 1)),
      },
      {
        key: "up",
        desc: "Scroll /btw answer up",
        group: "Dialog",
        cmd: () => setOffset(Math.max(0, offset() - 1)),
      },
      {
        key: "c",
        desc: "Clear /btw history",
        group: "Dialog",
        cmd: () => {
          history.splice(0, history.length)
          setHistoryVersion((value) => value + 1)
        },
      },
      {
        key: "f",
        desc: "Open /btw fork",
        group: "Dialog",
        cmd: () => {
          dialog.clear()
          route.navigate({ type: "session", sessionID: props.sessionID })
        },
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          /btw side question
        </text>
        <text fg={theme.textMuted}>enter/space dismiss · ↑↓ scroll · f fork · c clear · esc</text>
      </box>
      <box flexDirection="column" gap={0}>
        <text fg={theme.textMuted}>Q: {props.question}</text>
        <text fg={loading() ? theme.warning : theme.success}>{loading() ? "running" : "done"}</text>
      </box>
      <box
        maxHeight={12}
        overflow="hidden"
        flexDirection="column"
        border={["top", "bottom", "left", "right"]}
        borderColor={theme.borderSubtle}
        paddingLeft={1}
      >
        <For each={visible()}>
          {(line) => <text fg={theme.text}>{line}</text>}
        </For>
      </box>
      <box flexDirection="column" gap={0}>
        <text fg={theme.textMuted}>History</text>
        <Show when={visibleHistory().length > 0} fallback={<text fg={theme.textMuted}>No previous /btw questions.</text>}>
          <For each={visibleHistory()}>
            {(item) => (
              <text fg={item.sessionID === props.sessionID ? theme.primary : theme.textMuted} wrapMode="none" overflow="hidden">
                {new Date(item.time).toLocaleTimeString()} · {item.question}
              </text>
            )}
          </For>
        </Show>
      </box>
    </box>
  )
}
