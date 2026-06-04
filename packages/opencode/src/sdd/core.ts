import fs from "node:fs"
import path from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { z } from "zod"

const DEFAULT_SCHEMA = "spec-driven"
const WORKFLOW_CONFIG_PATH = ".opencode/workflow/config.yaml"
const DEFAULT_SCHEMAS_DIR = ".opencode/workflow/schemas"
const DEFAULT_CHANGES_DIR = "openspec/changes"

const ArtifactSchema = z.object({
  id: z.string().min(1),
  generates: z.string().min(1),
  description: z.string(),
  template: z.string().min(1),
  instruction: z.string().optional(),
  requires: z.array(z.string()).default([]),
})

const ApplyPhaseSchema = z.object({
  requires: z.array(z.string()).min(1),
  tracks: z.string().nullable().optional(),
  instruction: z.string().optional(),
})

const WorkflowSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().optional(),
  artifacts: z.array(ArtifactSchema).min(1),
  apply: ApplyPhaseSchema.optional(),
})

const WorkflowConfigSchema = z.object({
  defaultSchema: z.string().min(1).optional(),
  schemasDir: z.string().min(1).optional(),
  changesDir: z.string().min(1).optional(),
})

const ChangeMetadataSchema = z.object({
  schema: z.string().min(1).optional(),
  createdAt: z.string().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
})

export type Artifact = z.infer<typeof ArtifactSchema>
export type WorkflowSchemaInfo = z.infer<typeof WorkflowSchema>
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>
export type SchemaSource = "project" | "fallback"

export interface LoadedSchema {
  name: string
  source: SchemaSource
  schemaDir: string | null
  schemaPath: string | null
  schema: WorkflowSchemaInfo
}

export interface ValidationIssue {
  path: string
  message: string
}

export interface SchemaSummary {
  name: string
  description: string
  source: SchemaSource
  artifacts: string[]
  schemaPath: string | null
}

export interface ArtifactStatus {
  id: string
  description: string
  generates: string
  outputPaths: string[]
  status: "done" | "ready" | "blocked"
  requires: string[]
  missingDeps: string[]
}

export interface ChangeStatus {
  changeName: string
  schemaName: string
  changeRoot: string
  isComplete: boolean
  nextArtifact: string | null
  artifacts: ArtifactStatus[]
}

export interface ChangeSummary {
  changeName: string
  changeRoot: string
  schemaName: string
  status: ChangeStatus
}

const FALLBACK_SPEC_DRIVEN_SCHEMA = `name: spec-driven
version: 1
description: Default OpenSpec workflow - proposal -> specs -> design -> tasks
artifacts:
  - id: proposal
    generates: proposal.md
    description: Initial proposal document outlining the change
    template: proposal.md
    instruction: Create the proposal document that establishes why this change is needed.
    requires: []
  - id: specs
    generates: "specs/**/*.md"
    description: Detailed specifications for the change
    template: spec.md
    instruction: Create specification files that define what the system should do.
    requires: [proposal]
  - id: design
    generates: design.md
    description: Technical design document with implementation details
    template: design.md
    instruction: Create the design document that explains how to implement the change.
    requires: [proposal]
  - id: tasks
    generates: tasks.md
    description: Implementation checklist with trackable tasks
    template: tasks.md
    instruction: Create the task list that breaks down implementation work.
    requires: [specs, design]
apply:
  requires: [tasks]
  tracks: tasks.md
  instruction: Read context files, work through pending tasks, mark complete as you go.
`

const FALLBACK_TEMPLATES: Record<string, Record<string, string>> = {
  "spec-driven": {
    "proposal.md": `# Proposal: <change>

## Why

## What Changes

## Capabilities

## Impact
`,
    "spec.md": `## ADDED Requirements

### Requirement: <name>
The system SHALL ...

#### Scenario: <name>
- **WHEN** ...
- **THEN** ...
`,
    "design.md": `# Design: <change>

## Context

## Goals / Non-Goals

## Decisions

## Risks / Trade-offs

## Migration Plan

## Open Questions
`,
    "tasks.md": `# Tasks: <change>

## 1. Implementation

- [ ] 1.1 Add implementation tasks
`,
  },
}

function resolveProjectRoot(projectRoot: string) {
  return path.resolve(projectRoot || process.cwd())
}

function readYamlFile(filePath: string) {
  return parseYaml(fs.readFileSync(filePath, "utf8"))
}

function pathExists(filePath: string) {
  return fs.existsSync(filePath)
}

function ensureInsideProject(projectRoot: string, candidate: string) {
  const resolvedRoot = resolveProjectRoot(projectRoot)
  const resolved = path.resolve(resolvedRoot, candidate)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes project root: ${candidate}`)
  }
  return resolved
}

export function readWorkflowConfig(projectRoot: string): Required<WorkflowConfig> {
  const root = resolveProjectRoot(projectRoot)
  const configPath = path.join(root, WORKFLOW_CONFIG_PATH)
  if (!pathExists(configPath)) {
    return {
      defaultSchema: DEFAULT_SCHEMA,
      schemasDir: DEFAULT_SCHEMAS_DIR,
      changesDir: DEFAULT_CHANGES_DIR,
    }
  }

  const result = WorkflowConfigSchema.safeParse(readYamlFile(configPath))
  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ")
    throw new Error(`Invalid ${WORKFLOW_CONFIG_PATH}: ${errors}`)
  }

  return {
    defaultSchema: result.data.defaultSchema ?? DEFAULT_SCHEMA,
    schemasDir: result.data.schemasDir ?? DEFAULT_SCHEMAS_DIR,
    changesDir: result.data.changesDir ?? DEFAULT_CHANGES_DIR,
  }
}

export function parseWorkflowSchema(content: string): WorkflowSchemaInfo {
  const parsed = parseYaml(content)
  const result = WorkflowSchema.safeParse(parsed)
  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ")
    throw new Error(`Invalid schema: ${errors}`)
  }

  validateUniqueArtifactIds(result.data.artifacts)
  validateRequires(result.data.artifacts)
  validateAcyclic(result.data.artifacts)
  validateApplyRequires(result.data)

  return result.data
}

function validateUniqueArtifactIds(artifacts: Artifact[]) {
  const seen = new Set<string>()
  for (const artifact of artifacts) {
    if (seen.has(artifact.id)) throw new Error(`Duplicate artifact ID: ${artifact.id}`)
    seen.add(artifact.id)
  }
}

function validateRequires(artifacts: Artifact[]) {
  const ids = new Set(artifacts.map((artifact) => artifact.id))
  for (const artifact of artifacts) {
    for (const required of artifact.requires) {
      if (!ids.has(required)) {
        throw new Error(`Invalid dependency reference in artifact '${artifact.id}': '${required}' does not exist`)
      }
    }
  }
}

function validateApplyRequires(schema: WorkflowSchemaInfo) {
  if (!schema.apply) return
  const ids = new Set(schema.artifacts.map((artifact) => artifact.id))
  for (const required of schema.apply.requires) {
    if (!ids.has(required)) throw new Error(`Invalid apply dependency reference: '${required}' does not exist`)
  }
}

function validateAcyclic(artifacts: Artifact[]) {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const visited = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []

  function visit(id: string): void {
    if (active.has(id)) {
      const start = stack.indexOf(id)
      const cycle = [...stack.slice(start), id].join(" -> ")
      throw new Error(`Cyclic dependency detected: ${cycle}`)
    }
    if (visited.has(id)) return

    visited.add(id)
    active.add(id)
    stack.push(id)
    for (const dependency of byId.get(id)?.requires ?? []) visit(dependency)
    stack.pop()
    active.delete(id)
  }

  for (const artifact of artifacts) visit(artifact.id)
}

function getProjectSchemaDir(projectRoot: string, schemaName: string) {
  const config = readWorkflowConfig(projectRoot)
  return path.join(ensureInsideProject(projectRoot, config.schemasDir), schemaName)
}

function loadSchemaFromDir(schemaName: string, source: SchemaSource, schemaDir: string): LoadedSchema {
  const schemaPath = path.join(schemaDir, "schema.yaml")
  return {
    name: schemaName,
    source,
    schemaDir,
    schemaPath,
    schema: parseWorkflowSchema(fs.readFileSync(schemaPath, "utf8")),
  }
}

export function loadSchema(projectRoot: string, schemaName?: string): LoadedSchema {
  const name = schemaName ?? readWorkflowConfig(projectRoot).defaultSchema
  const projectSchemaDir = getProjectSchemaDir(projectRoot, name)
  if (pathExists(path.join(projectSchemaDir, "schema.yaml"))) {
    return loadSchemaFromDir(name, "project", projectSchemaDir)
  }

  if (name === DEFAULT_SCHEMA) {
    return {
      name,
      source: "fallback",
      schemaDir: null,
      schemaPath: null,
      schema: parseWorkflowSchema(FALLBACK_SPEC_DRIVEN_SCHEMA),
    }
  }

  throw new Error(`Schema '${name}' not found in ${DEFAULT_SCHEMAS_DIR}`)
}

function listProjectSchemas(projectRoot: string): SchemaSummary[] {
  const config = readWorkflowConfig(projectRoot)
  const schemasRoot = ensureInsideProject(projectRoot, config.schemasDir)
  if (!pathExists(schemasRoot)) return []

  return fs
    .readdirSync(schemasRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const schemaPath = path.join(schemasRoot, entry.name, "schema.yaml")
      if (!pathExists(schemaPath)) return []
      try {
        const schema = parseWorkflowSchema(fs.readFileSync(schemaPath, "utf8"))
        return [
          {
            name: entry.name,
            description: schema.description ?? "",
            source: "project" as const,
            artifacts: schema.artifacts.map((artifact) => artifact.id),
            schemaPath,
          },
        ]
      } catch {
        return [
          {
            name: entry.name,
            description: "",
            source: "project" as const,
            artifacts: [],
            schemaPath,
          },
        ]
      }
    })
}

export function listSchemas(projectRoot: string): { defaultSchema: string; schemas: SchemaSummary[] } {
  const config = readWorkflowConfig(projectRoot)
  const schemas = listProjectSchemas(projectRoot)

  if (!schemas.some((schema) => schema.name === DEFAULT_SCHEMA)) {
    schemas.push({
      name: DEFAULT_SCHEMA,
      description: "Default OpenSpec workflow - proposal -> specs -> design -> tasks",
      source: "fallback",
      artifacts: ["proposal", "specs", "design", "tasks"],
      schemaPath: null,
    })
  }

  return { defaultSchema: config.defaultSchema, schemas }
}

function validateTemplates(schema: LoadedSchema): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const artifact of schema.schema.artifacts) {
    if (readTemplate(schema, artifact.template) === null) {
      issues.push({
        path: `artifacts.${artifact.id}.template`,
        message: `Template '${artifact.template}' not found`,
      })
    }
  }
  return issues
}

export function validateSchema(projectRoot: string, schemaName?: string) {
  const name = schemaName ?? readWorkflowConfig(projectRoot).defaultSchema
  try {
    const schema = loadSchema(projectRoot, name)
    const issues = validateTemplates(schema)
    return {
      valid: issues.length === 0,
      schema: schema.name,
      source: schema.source,
      path: schema.schemaPath,
      issues,
    }
  } catch (error) {
    return {
      valid: false,
      schema: name,
      source: null,
      path: null,
      issues: [{ path: "schema.yaml", message: error instanceof Error ? error.message : String(error) }],
    }
  }
}

function getChangesDir(projectRoot: string) {
  const config = readWorkflowConfig(projectRoot)
  return ensureInsideProject(projectRoot, config.changesDir)
}

function validateChangeName(change: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change)) {
    throw new Error(`Invalid change '${change}'. Use kebab-case, for example add-user-auth`)
  }
}

function getChangeDir(projectRoot: string, change: string) {
  validateChangeName(change)
  return path.join(getChangesDir(projectRoot), change)
}

function getMetadataPath(changeDir: string) {
  return path.join(changeDir, ".openspec.yaml")
}

function readChangeMetadata(changeDir: string): z.infer<typeof ChangeMetadataSchema> {
  const metadataPath = getMetadataPath(changeDir)
  if (!pathExists(metadataPath)) return {}
  const result = ChangeMetadataSchema.safeParse(readYamlFile(metadataPath))
  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ")
    throw new Error(`Invalid change metadata at ${metadataPath}: ${errors}`)
  }
  return result.data
}

function resolveSchemaForChange(projectRoot: string, changeDir: string, schemaName?: string) {
  if (schemaName) return loadSchema(projectRoot, schemaName)
  const metadata = readChangeMetadata(changeDir)
  return loadSchema(projectRoot, metadata.schema)
}

export function createChange(
  projectRoot: string,
  input: { change: string; schema?: string; title?: string; summary?: string },
) {
  const root = resolveProjectRoot(projectRoot)
  validateChangeName(input.change)
  const schema = loadSchema(root, input.schema)
  const changeDir = getChangeDir(root, input.change)
  if (pathExists(changeDir)) throw new Error(`Change '${input.change}' already exists at ${changeDir}`)

  fs.mkdirSync(changeDir, { recursive: true })
  const metadata = {
    schema: schema.name,
    createdAt: new Date().toISOString(),
    ...(input.title ? { title: input.title } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
  }
  const metadataPath = getMetadataPath(changeDir)
  fs.writeFileSync(metadataPath, stringifyYaml(metadata), "utf8")

  return {
    changeName: input.change,
    changeRoot: changeDir,
    schemaName: schema.name,
    metadataPath,
    status: getStatus(root, input.change),
  }
}

export function listChanges(projectRoot: string): ChangeSummary[] {
  const changesDir = getChangesDir(projectRoot)
  if (!pathExists(changesDir)) return []
  return fs
    .readdirSync(changesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "archive")
    .flatMap((entry) => {
      try {
        const status = getStatus(projectRoot, entry.name)
        return [{ changeName: entry.name, changeRoot: status.changeRoot, schemaName: status.schemaName, status }]
      } catch {
        return []
      }
    })
}

function isGlobPattern(value: string) {
  return value.includes("*") || value.includes("?") || value.includes("[")
}

function globBase(pattern: string) {
  const parts = pattern.split(/[\\/]/)
  const wildcardIndex = parts.findIndex((part) => isGlobPattern(part))
  return wildcardIndex === -1 ? path.dirname(pattern) : parts.slice(0, wildcardIndex).join(path.sep) || "."
}

function globToRegExp(pattern: string) {
  const normalized = pattern.replace(/\\/g, "/")
  let regex = "^"
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]
    const next = normalized[index + 1]
    if (char === "*" && next === "*") {
      regex += ".*"
      index++
    } else if (char === "*") {
      regex += "[^/]*"
    } else if (char === "?") {
      regex += "[^/]"
    } else {
      regex += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    }
  }
  regex += "$"
  return new RegExp(regex)
}

function listFilesRecursive(dir: string): string[] {
  if (!pathExists(dir)) return []
  const result: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name)
    if (entry.isDirectory()) result.push(...listFilesRecursive(next))
    if (entry.isFile()) result.push(next)
  }
  return result
}

function resolveOutputPaths(changeDir: string, generates: string) {
  const outputPattern = path.join(changeDir, generates)
  if (!isGlobPattern(generates)) return pathExists(outputPattern) ? [outputPattern] : []

  const base = path.join(changeDir, globBase(generates))
  const regex = globToRegExp(generates.replace(/\\/g, "/"))
  return listFilesRecursive(base).filter((filePath) => {
    const relative = path.relative(changeDir, filePath).replace(/\\/g, "/")
    return regex.test(relative)
  })
}

function resolveDesiredOutputPath(changeDir: string, generates: string) {
  return path.join(changeDir, generates)
}

export function getStatus(projectRoot: string, change: string): ChangeStatus {
  const root = resolveProjectRoot(projectRoot)
  const changeDir = getChangeDir(root, change)
  if (!pathExists(changeDir)) throw new Error(`Change '${change}' not found at ${changeDir}`)

  const loaded = resolveSchemaForChange(root, changeDir)
  const done = new Set<string>()
  const outputPaths = new Map<string, string[]>()

  for (const artifact of loaded.schema.artifacts) {
    const paths = resolveOutputPaths(changeDir, artifact.generates)
    outputPaths.set(artifact.id, paths)
    if (paths.length > 0) done.add(artifact.id)
  }

  const artifacts: ArtifactStatus[] = loaded.schema.artifacts.map((artifact) => {
    const missingDeps = artifact.requires.filter((required) => !done.has(required))
    const paths = outputPaths.get(artifact.id) ?? []
    return {
      id: artifact.id,
      description: artifact.description,
      generates: artifact.generates,
      outputPaths: paths,
      status: paths.length > 0 ? "done" : missingDeps.length === 0 ? "ready" : "blocked",
      requires: artifact.requires,
      missingDeps,
    }
  })

  return {
    changeName: change,
    schemaName: loaded.name,
    changeRoot: changeDir,
    isComplete: artifacts.every((artifact) => artifact.status === "done"),
    nextArtifact: artifacts.find((artifact) => artifact.status === "ready")?.id ?? null,
    artifacts,
  }
}

function readTemplate(schema: LoadedSchema, templateName: string) {
  if (schema.schemaDir) {
    for (const candidate of [
      path.join(schema.schemaDir, "templates", templateName),
      path.join(schema.schemaDir, templateName),
    ]) {
      if (pathExists(candidate)) return fs.readFileSync(candidate, "utf8")
    }
  }
  return FALLBACK_TEMPLATES[schema.name]?.[templateName] ?? null
}

function getArtifact(schema: WorkflowSchemaInfo, artifactId: string): Artifact {
  const artifact = schema.artifacts.find((item) => item.id === artifactId)
  if (!artifact) {
    const valid = schema.artifacts.map((item) => item.id).join(", ")
    throw new Error(`Artifact '${artifactId}' not found. Valid artifacts: ${valid}`)
  }
  return artifact
}

export function getArtifactInstructions(projectRoot: string, change: string, artifactId?: string) {
  const root = resolveProjectRoot(projectRoot)
  const status = getStatus(root, change)
  const selectedArtifactId = artifactId ?? status.nextArtifact
  if (!selectedArtifactId) throw new Error(`No ready artifact for change '${change}'`)

  const loaded = resolveSchemaForChange(root, status.changeRoot)
  const artifact = getArtifact(loaded.schema, selectedArtifactId)
  const artifactStatus = status.artifacts.find((item) => item.id === artifact.id)
  const template = readTemplate(loaded, artifact.template)
  if (template === null) throw new Error(`Template '${artifact.template}' not found for schema '${loaded.name}'`)

  return {
    changeName: change,
    schemaName: loaded.name,
    artifactId: artifact.id,
    blocked: artifactStatus?.status === "blocked",
    missingDeps: artifactStatus?.missingDeps ?? [],
    changeRoot: status.changeRoot,
    resolvedOutputPath: resolveDesiredOutputPath(status.changeRoot, artifact.generates),
    description: artifact.description,
    instruction: artifact.instruction ?? null,
    template,
    dependencies: artifact.requires.map((requiredId) => {
      const required = getArtifact(loaded.schema, requiredId)
      const requiredStatus = status.artifacts.find((item) => item.id === requiredId)
      return {
        id: required.id,
        description: required.description,
        generates: required.generates,
        outputPaths: requiredStatus?.outputPaths ?? [],
      }
    }),
    unlocks: loaded.schema.artifacts.filter((item) => item.requires.includes(artifact.id)).map((item) => item.id),
  }
}

function parseTasks(content: string) {
  const tasks: Array<{ id: string; description: string; done: boolean }> = []
  let index = 0
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^[-*]\s*\[([ xX])\]\s*(.+?)\s*$/)
    if (!match) continue
    index++
    tasks.push({
      id: String(index),
      description: match[2] ?? "",
      done: (match[1] ?? "").toLowerCase() === "x",
    })
  }
  return tasks
}

export function getApplyInstructions(projectRoot: string, change: string) {
  const root = resolveProjectRoot(projectRoot)
  const status = getStatus(root, change)
  const loaded = resolveSchemaForChange(root, status.changeRoot)
  const apply = loaded.schema.apply
  if (!apply) {
    return {
      changeName: change,
      schemaName: loaded.name,
      ready: status.isComplete,
      blockedBy: status.artifacts.filter((artifact) => artifact.status !== "done").map((artifact) => artifact.id),
      changeRoot: status.changeRoot,
      instruction: null,
      trackingPath: null,
      tasks: [],
      requiredArtifacts: status.artifacts.map((artifact) => ({
        id: artifact.id,
        outputPaths: artifact.outputPaths,
        done: artifact.status === "done",
      })),
    }
  }

  const requiredArtifacts = apply.requires.map((id) => {
    const artifact = status.artifacts.find((item) => item.id === id)
    return {
      id,
      outputPaths: artifact?.outputPaths ?? [],
      done: artifact?.status === "done",
    }
  })
  const blockedBy = requiredArtifacts.filter((artifact) => !artifact.done).map((artifact) => artifact.id)
  const trackingPath = apply.tracks ? path.join(status.changeRoot, apply.tracks) : null
  const tasks = trackingPath && pathExists(trackingPath) ? parseTasks(fs.readFileSync(trackingPath, "utf8")) : []

  return {
    changeName: change,
    schemaName: loaded.name,
    ready: blockedBy.length === 0,
    blockedBy,
    changeRoot: status.changeRoot,
    instruction: apply.instruction ?? null,
    trackingPath,
    tasks,
    requiredArtifacts,
  }
}

export function getSnapshot(projectRoot: string) {
  return {
    schemas: listSchemas(projectRoot),
    changes: listChanges(projectRoot),
  }
}
