import type { Plugin } from "@opencode-ai/plugin"

const command = "btw"
const description = "ask a side question in a background fork"
const marker = "<opencode-btw>\n"

export const BtwPlugin: Plugin = async (input) => {
  return {
    config(config) {
      // #region btw
      config.command = {
        ...config.command,
        [command]: {
          description,
          template: `${marker}$ARGUMENTS`,
        },
      }
      // #endregion btw
    },
    async "chat.message"(hook, output) {
      // #region btw
      const text = output.parts.find((part) => part.type === "text" && part.text?.startsWith(marker))
      if (!text || text.type !== "text") return

      output.noReply = true
      const question = text.text.slice(marker.length).trim()
      if (!question) {
        text.text = "Usage: /btw <question>"
        text.synthetic = true
        return
      }

      const result = await input.client.session.btw({
        path: { id: hook.sessionID },
        body: {
          question,
          agent: hook.agent,
          model: hook.model,
          variant: hook.variant,
        },
      })
      text.text = result.error
        ? `Failed to start /btw side question: ${result.error.name}: ${result.error.data.message}`
        : (result.data?.message ?? "Started /btw side question.")
      text.synthetic = true
      // #endregion btw
    },
  }
}
