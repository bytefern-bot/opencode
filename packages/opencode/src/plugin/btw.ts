import type { Plugin } from "@opencode-ai/plugin"

const command = "btw"
const description = "ask a side question in a background fork"

export const BtwPlugin: Plugin = async (input) => {
  return {
    async config(config) {
      // #region btw
      config.command = {
        ...config.command,
        [command]: {
          description,
          template: "$ARGUMENTS",
        },
      }
      // #endregion btw
    },
    async "command.execute.before"(hook, output) {
      // #region btw
      if (hook.command !== command) return

      const question = hook.arguments.trim()
      if (!question) {
        output.handled = { message: "Usage: /btw <question>" }
        return
      }

      const result = await input.client.session.btw({ path: { id: hook.sessionID }, body: { question } })
      output.handled = {
        message: result.error
          ? `Failed to start /btw side question: ${result.error.name}: ${result.error.data.message}`
          : (result.data?.message ?? "Started /btw side question."),
        metadata: result.data
          ? {
              kind: "btw",
              sessionID: result.data.sessionID,
              question,
            }
          : undefined,
      }
      // #endregion btw
    },
  }
}
