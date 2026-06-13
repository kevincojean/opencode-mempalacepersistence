import { createServer, type Server } from "http"
import { type AddressInfo } from "net"

let server: Server | null = null
let activePort: number | null = null

const FIXTURE_RESPONSE = JSON.stringify({
  id: "test-cmpl-1",
  object: "chat.completion",
  created: 0,
  model: "test-model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Hello world",
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
})

export async function startTestProvider(): Promise<number> {
  if (server) return activePort!

  return new Promise<number>((resolve, reject) => {
    server = createServer((req, res) => {
      // OpenAI-compatible model discovery
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "test-model",
                object: "model",
                created: Date.now(),
                owned_by: "test",
              },
            ],
          }),
        )
        return
      }

      // Chat completions — respond instantly
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        })
        res.end(FIXTURE_RESPONSE)
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
