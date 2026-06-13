import { createServer, type Server } from "http"
import { type AddressInfo } from "net"

let server: Server | null = null
let activePort: number | null = null

const MODEL = "test-model"

const FIXTURE_DATA: Record<string, unknown> = {
  id: "test-cmpl-1",
  object: "chat.completion",
  created: Date.now(),
  model: MODEL,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello world" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
}

/**
 * Send an SSE-streamed chat completion. The provider AI SDK sends `stream: true`
 * by default, so this is the common path.
 */
function sendSSEStream(res: ReturnType<typeof createServer extends { new: (...args: any[]) => infer S } ? S : never> extends Server ? Server["prototype"] : any): void {
  const id = "test-chunk-1"
  const ts = Date.now()

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  })

  // Role announcement chunk
  res.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: ts,
      model: MODEL,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    })}\n\n`,
  )

  // Content chunk
  res.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: ts,
      model: MODEL,
      choices: [{ index: 0, delta: { content: "Hello world" }, finish_reason: null }],
    })}\n\n`,
  )

  // Final finish chunk
  res.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: ts,
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  )

  res.write("data: [DONE]\n\n")
  res.end()
}

function collectBody(req: any): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
  })
}

export async function startTestProvider(): Promise<number> {
  if (server) return activePort!

  return new Promise<number>((resolve, reject) => {
    server = createServer(async (req, res) => {
      // OpenAI-compatible model discovery
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: MODEL,
                object: "model",
                created: Date.now(),
                owned_by: "test",
              },
            ],
          }),
        )
        return
      }

      // Chat completions
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const body = await collectBody(req)
        let parsed: any = {}
        try {
          parsed = JSON.parse(body)
        } catch {
          // fall through
        }

        const isStream = parsed.stream === true

        if (isStream) {
          sendSSEStream(res)
        } else {
          // Non-streaming fallback
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          })
          res.end(JSON.stringify(FIXTURE_DATA))
        }
        return
      }

      res.writeHead(404)
      res.end("Not found")
    })

    server.listen(0, "127.0.0.1", () => {
      activePort = (server!.address() as AddressInfo).port
      resolve(activePort)
    })
    server.on("error", reject)
  })
}

export async function stopTestProvider(): Promise<void> {
  if (!server) return
  return new Promise((resolve) => {
    server!.close(() => {
      server = null
      activePort = null
      resolve()
    })
  })
}

export function testProviderPort(): number | null {
  return activePort
}
