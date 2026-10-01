/**
 * opencode-handoff V2 - Ported from V1 Plugin API
 *
 * Creates focused handoff prompts for continuing work in new sessions.
 * V2 Port: Converted from V1 Plugin API to V2 Plugin.define() pattern
 */

import { Plugin } from "@opencode/plugin"
import type { TextPartInput } from "@opencode-ai/sdk"
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
/**
 * Derive a display title for a completed tool part from its content.
 * V1 used `state.title`; V2 completed tool state carries content instead.
 */
function toolTitle(state: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
  const text = state.content?.find(c => c.type === "text" && c.text)?.text
  if (!text) return ""
  const firstLine = text.split("\n")[0] ?? ""
  return firstLine.length > 100 ? firstLine.slice(0, 97) + "..." : firstLine
}

// Message shapes from ctx.session.context() (SessionMessageInfo union).
// Typed loosely: the SDK union's text/tool part variants differ structurally
// and only the fields rendered below are relevant.
type V2Message = {
  type: string
  text?: string
  files?: ReadonlyArray<{ name?: string }>
  content?: ReadonlyArray<any>
}

/**
 * Format a conversation transcript for display (ported from V1 formatTranscript).
 *
 * V1 read `{ info: { role }, parts }` shapes from client.session.messages();
 * V2 session.context() returns flat messages, so the source shape differs but
 * the output format is identical: '## User' / '## Assistant' sections with
 * text rendered, file parts as '[Attached: <filename>]', and completed tool
 * parts as '[Tool: <tool>] <title>'.
 *
 * @param messages - Flat V2 session messages
 * @param limit - Limit used to indicate if results are truncated
 * @returns Formatted transcript with user/assistant sections
 */
export function formatTranscript(
  messages: ReadonlyArray<V2Message>,
  limit?: number
): string {
  const lines: string[] = []

  for (const msg of messages) {
    if (msg.type === "user") {
      lines.push("## User")
      if (msg.text) {
        lines.push(msg.text)
      }
      for (const file of msg.files ?? []) {
        lines.push(`[Attached: ${file.name || "file"}]`)
      }
      lines.push("")
    }

    if (msg.type === "assistant") {
      lines.push("## Assistant")
      for (const part of msg.content ?? []) {
        if (part.type === "text" && part.text) {
          lines.push(part.text)
        }
        if (part.type === "tool" && part.state?.status === "completed") {
          lines.push(`[Tool: ${part.name ?? "tool"}] ${toolTitle(part.state)}`)
        }
      }
      lines.push("")
    }
  }

  const output = lines.join("\n").trim()

  if (messages.length >= (limit ?? 100)) {
    return output + `\n\n(Showing ${messages.length} most recent messages. Use a higher 'limit' to see more.)`
  }

  return output + `\n\n(End of session - ${messages.length} messages)`
}

const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g

/**
 * TUI surface used for the review-before-send handoff flow.
 *
 * Not present in the current @opencode/plugin Context type declarations,
 * so it is accessed defensively at runtime; if the host does not provide it,
 * the tool reports a clear failure instead of crashing.
 */
interface TuiApi {
  executeCommand(input: { body: { command: string } }): Promise<void>
  appendPrompt(input: { body: { text: string } }): Promise<void>
  showToast(input: {
    body: { title: string; message: string; variant: string; duration: number }
  }): Promise<void>
}

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
    await ctx.command.transform((editor: any) => {
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
    await ctx.tool.transform((editor: any) => {
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
        async execute(input: any, context: { sessionID?: string }) {
          const args = input as { prompt: string; files?: string[] }
          // V2 passes the calling session's ID via the tool context (ToolContext.sessionID)
          const sessionReference = `Continuing work from session ${context.sessionID}. When you lack specific information you can use read_session to get it.`

          // Attach actual file contents (rendered as synthetic Read-tool output)
          // so the new session has the file context pre-loaded — plain @path
          // text alone doesn't carry the contents over.
          const refs = new Set((args.files ?? []).map(f => f.replace(/^@/, "")))
          const fileParts = refs.size
            ? await buildSyntheticFileParts(ctx.location.directory, refs)
            : []
          const fileContext = fileParts.length
            ? "\n\n" + fileParts.map(p => p.text).join("\n\n")
            : ""

          const fullPrompt = `${sessionReference}${fileContext}\n\n${args.prompt}`

          try {
            const tui = (ctx as unknown as { tui?: TuiApi }).tui
            if (!tui) {
              return { content: "Failed to create handoff session: TUI API is not available in this context." }
            }

            await tui.executeCommand({ body: { command: "session_new" } })
            // session_new is fire-and-forget (publishes a bus event, returns immediately).
            // The TUI needs time to navigate to the home screen and mount the new prompt
            // input before appendPrompt can insert text — otherwise the event is silently
            // dropped because the input component doesn't exist yet.
            await new Promise(r => setTimeout(r, 150))
            await tui.appendPrompt({ body: { text: fullPrompt } })

            await tui.showToast({
              body: {
                title: "Handoff Ready",
                message: "Review and edit the draft, then send",
                variant: "success",
                duration: 4000,
              },
            })

            return { content: "Handoff prompt created in new session. Review and edit before sending." }
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

          try {
            // V2 note: the plugin ctx exposes session.context() (flat messages),
            // not the V1 client's session.messages(). The limit is applied
            // client-side by slicing the most recent messages.
            const response = await ctx.session.context({ sessionID: args.sessionID })
            const messages = response.slice(-limit)

            if (messages.length === 0) {
              return { content: "Session has no messages or does not exist." }
            }

            return { content: formatTranscript(messages, limit) }
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error"
            return { content: `Could not read session ${args.sessionID}: ${message}` }
          }
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
