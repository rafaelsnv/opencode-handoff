import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/plugin"

/**
 * Mock V2 plugin context (Plugin.define setup ctx).
 * Captures everything registered through the transform editors and
 * exposes controllable session/tui/event surfaces for tool tests.
 */
function createMockCtx(directory: string) {
  const tools: Array<{ name: string; [key: string]: any }> = []
  const commands: Array<{ name: string; [key: string]: any }> = []
  const eventSignals: AbortSignal[] = []

  const ctx: any = {
    location: { directory },
    command: {
      transform(fn: (editor: any) => void) {
        fn({ add: (t: any) => commands.push(t) })
      },
    },
    tool: {
      transform(fn: (editor: any) => void) {
        fn({ add: (t: any) => tools.push(t) })
      },
    },
    event: {
      subscribe(input: { signal: AbortSignal }) {
        eventSignals.push(input.signal)
        // Long-lived stream, like the real event API. Never yields after
        // the first tick so the setup() consumer stays pending.
        async function* stream() {
          await new Promise<void>(() => {})
        }
        return stream()
      },
    },
    session: {} as any,
    tui: undefined as any,
  }

  return { ctx, tools, commands, eventSignals }
}

function getTool(tools: Array<{ name: string; [key: string]: any }>, name: string) {
  const tool = tools.find((t) => t.name === name)
  expect(tool).toBeDefined()
  return tool!
}

describe("opencode-handoff V2 plugin", () => {
  test("registers the handoff command via command.transform", async () => {
    const { ctx, commands, tools } = createMockCtx("/tmp/project")
    await plugin.setup(ctx)

    expect(commands).toHaveLength(1)
    expect(commands[0]!.name).toBe("handoff")
    expect(commands[0]!.description).toContain("handoff")
    expect(typeof commands[0]!.execute).toBe("function")

    expect(tools).toHaveLength(2)
    expect(tools.map((t) => t.name).sort()).toEqual(["handoff-session", "read_session"])
  })

  test("handoff-session opens a TUI draft with source session ID and file contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-handoff-v2-"))
    try {
      await writeFile(join(directory, "note.txt"), "handoff context")

      const { ctx, tools } = createMockCtx(directory)
      const tuiCalls: Array<{ name: string; input: any }> = []
      ctx.tui = {
        async executeCommand(input: any) {
          tuiCalls.push({ name: "executeCommand", input })
        },
        async appendPrompt(input: any) {
          tuiCalls.push({ name: "appendPrompt", input })
        },
        async showToast(input: any) {
          tuiCalls.push({ name: "showToast", input })
        },
      }
      await plugin.setup(ctx)

      const handoff = getTool(tools, "handoff-session")
      const result = await handoff.execute(
        {
          prompt: "Continue implementation",
          files: ["note.txt", "@missing.txt"],
        },
        { sessionID: "sess_source" }
      )

      expect(tuiCalls.map((c) => c.name)).toEqual([
        "executeCommand",
        "appendPrompt",
        "showToast",
      ])
      expect(tuiCalls[0]!.input).toEqual({ body: { command: "session_new" } })

      const appended = tuiCalls[1]!.input as { body: { text: string } }
      expect(appended.body.text).toContain(
        "Continuing work from session sess_source"
      )
      expect(appended.body.text).toContain("handoff context")
      expect(appended.body.text).not.toContain("missing.txt")
      expect(appended.body.text).toContain("Continue implementation")

      expect(tuiCalls[2]!.input).toMatchObject({
        body: { title: "Handoff Ready", variant: "success" },
      })
      expect(result.content).toContain("Review and edit")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("read_session fetches and formats the session transcript", async () => {
    const { ctx, tools } = createMockCtx("/tmp/project")
    const requests: unknown[] = []
    ctx.session = {
      async context(input: unknown) {
        requests.push(input)
        return [
          {
            type: "user",
            text: "hello",
            files: [{ name: "notes.txt" }],
          },
          {
            type: "assistant",
            content: [
              { type: "text", text: "done" },
              {
                type: "tool",
                name: "read",
                state: {
                  status: "completed",
                  content: [{ type: "text", text: "Read file" }],
                },
              },
              {
                type: "tool",
                name: "write",
                state: { status: "running" },
              },
            ],
          },
        ]
      },
    }
    await plugin.setup(ctx)

    const readSession = getTool(tools, "read_session")
    const result = await readSession.execute({ sessionID: "sess_old", limit: 2 })

    expect(requests).toEqual([{ sessionID: "sess_old" }])
    expect(result.content).toBe(
      [
        "## User",
        "hello",
        "[Attached: notes.txt]",
        "",
        "## Assistant",
        "done",
        "[Tool: read] Read file",
        "",
        "(Showing 2 most recent messages. Use a higher 'limit' to see more.)",
      ].join("\n")
    )
  })

  test("read_session reports empty sessions and errors without throwing", async () => {
    const { ctx, tools } = createMockCtx("/tmp/project")
    const requests: unknown[] = []
    ctx.session = {
      async context(input: unknown) {
        requests.push(input)
        if ((input as any).sessionID === "sess_fail") {
          throw new Error("offline")
        }
        return []
      },
    }
    await plugin.setup(ctx)

    const readSession = getTool(tools, "read_session")

    const empty = await readSession.execute({ sessionID: "sess_empty" })
    expect(empty.content).toBe("Session has no messages or does not exist.")

    const failure = await readSession.execute({ sessionID: "sess_fail", limit: 900 })
    expect(failure.content).toBe("Could not read session sess_fail: offline")
  })

  test("cleanup aborts the event subscription", async () => {
    const { ctx, eventSignals } = createMockCtx("/tmp/project")
    const cleanup = await plugin.setup(ctx)

    expect(eventSignals).toHaveLength(1)
    expect(eventSignals[0]!.aborted).toBe(false)

    cleanup?.()
    expect(eventSignals[0]!.aborted).toBe(true)
  })
})
