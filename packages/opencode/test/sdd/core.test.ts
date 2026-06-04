import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  createChange,
  getApplyInstructions,
  getArtifactInstructions,
  getStatus,
  listSchemas,
  validateSchema,
} from "../../src/sdd/core"
import { SddPlugin } from "../../src/plugin/sdd"

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sdd-"))
}

function write(root: string, file: string, content: string) {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, "utf8")
}

function writeSchema(root: string, name: string, schema: string, templates: Record<string, string> = {}) {
  write(root, `.opencode/workflow/schemas/${name}/schema.yaml`, schema)
  for (const [template, content] of Object.entries(templates)) {
    write(root, `.opencode/workflow/schemas/${name}/templates/${template}`, content)
  }
}

const validSchema = `name: custom
version: 1
description: Custom SDD workflow
artifacts:
  - id: proposal
    generates: proposal.md
    description: Proposal
    template: proposal.md
    requires: []
  - id: tasks
    generates: tasks.md
    description: Tasks
    template: tasks.md
    requires: [proposal]
apply:
  requires: [tasks]
  tracks: tasks.md
`

const templates = {
  "proposal.md": "# Proposal\n",
  "tasks.md": "# Tasks\n\n- [ ] 1.1 Implement\n- [x] 1.2 Done\n",
}

describe("sdd core", () => {
  test("validates a project schema and lists fallback schema", () => {
    const root = tmpProject()
    writeSchema(root, "custom", validSchema, templates)

    const validation = validateSchema(root, "custom")
    expect(validation.valid).toBe(true)
    expect(validation.issues).toEqual([])

    const schemas = listSchemas(root)
    expect(schemas.schemas.map((schema) => schema.name)).toContain("custom")
    expect(schemas.schemas.map((schema) => schema.name)).toContain("spec-driven")
  })

  test("reports duplicate artifacts, bad requires, cycles, and missing templates", () => {
    const root = tmpProject()
    writeSchema(
      root,
      "duplicate",
      `name: duplicate
version: 1
artifacts:
  - id: one
    generates: one.md
    description: One
    template: one.md
  - id: one
    generates: two.md
    description: Two
    template: two.md
`,
    )
    writeSchema(
      root,
      "bad-requires",
      `name: bad-requires
version: 1
artifacts:
  - id: one
    generates: one.md
    description: One
    template: one.md
    requires: [missing]
`,
    )
    writeSchema(
      root,
      "cycle",
      `name: cycle
version: 1
artifacts:
  - id: one
    generates: one.md
    description: One
    template: one.md
    requires: [two]
  - id: two
    generates: two.md
    description: Two
    template: two.md
    requires: [one]
`,
    )
    writeSchema(
      root,
      "missing-template",
      `name: missing-template
version: 1
artifacts:
  - id: one
    generates: one.md
    description: One
    template: missing.md
`,
    )

    expect(validateSchema(root, "duplicate").issues[0]?.message).toContain("Duplicate artifact ID")
    expect(validateSchema(root, "bad-requires").issues[0]?.message).toContain("does not exist")
    expect(validateSchema(root, "cycle").issues[0]?.message).toContain("Cyclic dependency")
    expect(validateSchema(root, "missing-template")).toEqual(
      expect.objectContaining({
        valid: false,
        issues: [expect.objectContaining({ path: "artifacts.one.template" })],
      }),
    )
  })

  test("uses config default schema and refuses to overwrite an existing change", () => {
    const root = tmpProject()
    write(root, ".opencode/workflow/config.yaml", "defaultSchema: custom\n")
    writeSchema(root, "custom", validSchema, templates)

    const created = createChange(root, { change: "add-login" })
    expect(created.schemaName).toBe("custom")
    expect(() => createChange(root, { change: "add-login" })).toThrow("already exists")
  })

  test("computes ready, blocked, done, instructions, and apply task state", () => {
    const root = tmpProject()
    writeSchema(root, "custom", validSchema, templates)
    createChange(root, { change: "add-login", schema: "custom" })

    let status = getStatus(root, "add-login")
    expect(status.nextArtifact).toBe("proposal")
    expect(status.artifacts.find((artifact) => artifact.id === "tasks")?.status).toBe("blocked")

    const instructions = getArtifactInstructions(root, "add-login")
    expect(instructions.artifactId).toBe("proposal")
    expect(instructions.resolvedOutputPath.endsWith("proposal.md")).toBe(true)

    write(root, "openspec/changes/add-login/proposal.md", "# Proposal\n")
    status = getStatus(root, "add-login")
    expect(status.nextArtifact).toBe("tasks")

    write(root, "openspec/changes/add-login/tasks.md", templates["tasks.md"])
    status = getStatus(root, "add-login")
    expect(status.isComplete).toBe(true)

    const apply = getApplyInstructions(root, "add-login")
    expect(apply.ready).toBe(true)
    expect(apply.tasks).toEqual([
      { id: "1", description: "1.1 Implement", done: false },
      { id: "2", description: "1.2 Done", done: true },
    ])
  })
})

describe("sdd internal plugin", () => {
  test("registers SDD tools and commands", async () => {
    const hooks = await SddPlugin({} as never)
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "sdd_apply_instructions",
      "sdd_change_new",
      "sdd_instructions",
      "sdd_schema_list",
      "sdd_schema_validate",
      "sdd_status",
    ])
    expect(Object.keys(hooks.command ?? {}).sort()).toEqual(["sdd-apply", "sdd-new", "sdd-next", "sdd-status"])
  })
})
