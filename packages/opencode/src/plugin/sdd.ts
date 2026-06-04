import { SddCore } from "@/sdd"
import { type Plugin, tool } from "@opencode-ai/plugin"

type SddPluginOptions = {
  publish?: (event: "created" | "updated", data: { changeName: string; schemaName: string; changeRoot: string }) => void
}

function format(value: unknown) {
  return JSON.stringify(value, null, 2)
}

export const SddPlugin: Plugin = async (_input, options) => {
  const sddOptions = options as SddPluginOptions | undefined
  return {
    command: {
      "sdd-new": {
        description: "Start a new SDD change",
        template: `Create a new SDD change from the user arguments.

Use the \`sdd_change_new\` tool with:
- \`change\`: \`$1\`
- \`schema\`: \`$2\` only if provided

After the change is created, call \`sdd_instructions\` with the same \`change\` and no artifact so the next ready artifact instructions are returned.

Report the change root, schema name, next artifact, and output path.`,
      },
      "sdd-next": {
        description: "Continue the next SDD artifact",
        template: `Continue the SDD workflow for change \`$1\`.

Call \`sdd_status\` with \`change: "$1"\`.

If \`nextArtifact\` is not null, call \`sdd_instructions\` with \`change: "$1"\` and no artifact.

If no artifact is ready and the change is complete, call \`sdd_apply_instructions\` with \`change: "$1"\`.

Report blockers when artifacts are blocked.`,
      },
      "sdd-status": {
        description: "Show SDD workflow status",
        template: `Show SDD workflow status for change \`$1\`.

Call \`sdd_status\` with \`change: "$1"\`.

Summarize schema, change root, completed artifacts, blocked artifacts, and next ready artifact.`,
      },
      "sdd-apply": {
        description: "Enter SDD apply phase",
        template: `Prepare to implement change \`$1\`.

Call \`sdd_apply_instructions\` with \`change: "$1"\`.

If \`ready\` is false, stop and report the required artifacts listed in \`blockedBy\`.

If \`ready\` is true, read the returned tracking file and pending tasks, then proceed through the tasks while marking completed items in the tracking file.`,
      },
    },
    tool: {
      sdd_schema_list: tool({
        description: "List SDD workflow schemas from .opencode/workflow and OpenSpec built-ins.",
        args: {},
        async execute(_args, context) {
          return {
            title: "SDD schemas",
            output: format(SddCore.listSchemas(context.worktree)),
          }
        },
      }),
      sdd_schema_validate: tool({
        description: "Validate an SDD workflow schema using the OpenSpec schema format.",
        args: {
          schema: tool.schema.string().optional().describe("Schema name. Defaults to workflow config defaultSchema."),
        },
        async execute(args, context) {
          return {
            title: "SDD schema validation",
            output: format(SddCore.validateSchema(context.worktree, args.schema)),
          }
        },
      }),
      sdd_change_new: tool({
        description: "Create a new OpenSpec-style SDD change and persist schema metadata.",
        args: {
          change: tool.schema.string().describe("Kebab-case change id, for example add-user-auth."),
          schema: tool.schema.string().optional().describe("Optional schema name override."),
          title: tool.schema.string().optional().describe("Optional human title for metadata."),
          summary: tool.schema.string().optional().describe("Optional short summary for metadata."),
        },
        async execute(args, context) {
          const result = SddCore.createChange(context.worktree, args)
          const event = {
            changeName: result.changeName,
            schemaName: result.schemaName,
            changeRoot: result.changeRoot,
          }
          sddOptions?.publish?.("created", event)
          sddOptions?.publish?.("updated", event)
          return {
            title: "SDD change created",
            output: format(result),
          }
        },
      }),
      sdd_status: tool({
        description: "Read SDD change status and identify the next ready artifact.",
        args: {
          change: tool.schema.string().describe("Change id."),
        },
        async execute(args, context) {
          return {
            title: "SDD status",
            output: format(SddCore.getStatus(context.worktree, args.change)),
          }
        },
      }),
      sdd_instructions: tool({
        description: "Return schema-aware instructions for creating the next or requested SDD artifact.",
        args: {
          change: tool.schema.string().describe("Change id."),
          artifact: tool.schema.string().optional().describe("Artifact id. Defaults to the first ready artifact."),
        },
        async execute(args, context) {
          return {
            title: "SDD artifact instructions",
            output: format(SddCore.getArtifactInstructions(context.worktree, args.change, args.artifact)),
          }
        },
      }),
      sdd_apply_instructions: tool({
        description: "Return schema-aware implementation instructions for a change's apply phase.",
        args: {
          change: tool.schema.string().describe("Change id."),
        },
        async execute(args, context) {
          return {
            title: "SDD apply instructions",
            output: format(SddCore.getApplyInstructions(context.worktree, args.change)),
          }
        },
      }),
    },
  }
}
