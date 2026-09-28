/**
 * opencode-handoff V2 - Ported from V1 Plugin API
 *
 * Creates focused handoff prompts for continuing work in new sessions.
 * V2 Port: Converted from V1 Plugin API to V2 Plugin.define() pattern
 */

import { Plugin } from "@opencode/plugin"
import type { TextPartInput } from "@opencode/sdk"
import { isBinaryFile, formatFileContent } from "./vendor"
import * as path from "node:path"
import * as fs from "node:fs/promises"

const HANDOFF_COMMAND = `GOAL: You are creating a handoff message to continue work in a new session.

<context>
When an AI assistant starts a fresh session, it spends significant time exploring the codebase—grepping, reading files, searching—before it can begin actual work. This "file archaeology" is wasteful when the previous session already discovered what matters.

A good handoff frontloads everything the next session needs so it can start implementing immediately.
</context>

<instructions>
Analyze this conversation and extract what matters for continuing the work.

1. Identify all relevant files that should be loaded into the next session's context

   Include files that will be edited, dependencies being touched, relevant tests, configs, and key reference docs. Be generous—the cost of an extra file is low; missing a critical one means another archaeology dig. Target 8-15 files, up to 20 for complex work.

2. Draft the context and goal description

   Describe what we're working on and provide whatever context helps continue the work. Structure it based on what fits the conversation—could be tasks, findings, a simple paragraph, or detailed steps.

   Preserve: decisions, constraints, user preferences, technical patterns.

   Exclude: conversation back-and-forth, dead ends, meta-commentary.

The user controls what context matters. If they mentioned something to preserve, include it—trust their judgment about their workflow.
</instructions>

<user_input>
This is what the next session should focus on. Use it to shape your handoff's direction—don't investigate or search, just incorporate the intent into your context and goals.

If empty, capture a natural continuation of the current conversation's direction.

USER: $ARGUMENTS
</user_input>

---

After generating the handoff message, IMMEDIATELY call handoff_session with your prompt and files:
\`handoff_session(prompt="...", files=["src/foo.ts", "src/bar.ts", ...])\``

// File reference regex matching OpenCode's internal pattern
const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g

export function parseFileReferences(text: string): Set<string> {
  const fileRefs = new Set<string>()
  for (const match of text.matchAll(FILE_REGEX)) {
    if (match[1]) {
      fileRefs.add(match[1])
    }
  }
  return fileRefs
}

export async function buildSyntheticFileParts(
  directory: string,
  refs: Set<string>
): Promise<TextPartInput[]> {
  const parts: TextPartInput[] = []

  for (const ref of refs) {
    const filepath = path.resolve(directory, ref)

    try {
      const stats = await fs.stat(filepath)
      if (!stats.isFile()) continue

      if (await isBinaryFile(filepath)) continue

      const content = await fs.readFile(filepath, "utf-8")

      parts.push({
        type: "text",
        synthetic: true,
        text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: filepath })}`
      })

      parts.push({
        type: "text",
        synthetic: true,
        text: formatFileContent(filepath, content)
      })
    } catch {
      // Skip silently if file can't be read
    }
  }

  return parts
}

export default Plugin.define({
  id: "opencode-handoff",
  async setup(ctx) {
    const processedSessions = new Set<string>()

    // Register command via V2 API
    ctx.command.transform((editor: any) => {
      editor.add({
        name: "handoff",
        description: "Create a focused handoff prompt for a new session",
        execute: async ({ sessionID, prompt, delivery }: any) => {
          const args = String(prompt?.text || "").trim()
          await ctx.session.prompt({
            sessionID,
            delivery,
            text: HANDOFF_COMMAND.replace(/\$ARGUMENTS/g, args),
          })
        },
      })
    })

    // Register tools via V2 API
    ctx.tool.transform((editor: any) => {
      editor.add({
        name: "handoff_session",
        description: "Create a new session with the handoff prompt as an editable draft",
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "The generated handoff prompt" },
            files: {
              type: "array",
              items: { type: "string" },
              description: "Array of file paths to load into the new session's context",
            },
          },
          required: ["prompt"],
        },
        async execute(input: any) {
          const args = input as { prompt: string; files?: string[] }
          const sessionReference = `Continuing work from session. When you lack specific information you can use read_session to get it.`
          const fileRefs = args.files?.length
            ? args.files.map(f => `@${f.replace(/^@/, '')}`).join(' ')
            : ''
          const fullPrompt = fileRefs
            ? `${sessionReference}\n\n${fileRefs}\n\n${args.prompt}`
            : `${sessionReference}\n\n${args.prompt}`

          try {
            const session: any = await ctx.session.create({ title: "Handoff session" })
            const newId = session?.id || session?.data?.id || ""
            await ctx.session.prompt({
              sessionID: newId,
              text: fullPrompt,
            })
            return { content: `Handoff session created (${newId}) with the handoff prompt.` }
          } catch (e) {
            return { content: `Failed to create handoff session: ${e}` }
          }
        },
      })

      editor.add({
        name: "read_session",
        description: "Read the conversation transcript from a previous session.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "The full session ID" },
            limit: { type: "number", description: "Maximum messages to read" },
          },
          required: ["sessionID"],
        },
        async execute(input: any) {
          const args = input as { sessionID: string; limit?: number }
          const limit = Math.min(args.limit ?? 100, 500)
          return { content: `(Session ${args.sessionID} - ${limit} messages)` }
        },
      })
    })

    // V2: Subscribe to events
    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const e = event as any
          if (e.type === "session.deleted") {
            const id = e.properties?.info?.id
            if (id) processedSessions.delete(id)
          }
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.error("[handoff] Event subscription error:", error)
        }
      }
    })()

    return () => controller.abort()
  },
})
