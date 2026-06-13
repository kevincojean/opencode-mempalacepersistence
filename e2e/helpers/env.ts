import { randomUUID } from "crypto"
import { mkdir, writeFile, symlink, rm } from "fs/promises"
import { existsSync, realpathSync } from "fs"
import { join } from "path"
import { execa } from "execa"

export interface TestEnvConfig {
  autoInjectContext: boolean
  identity: string
  opencodeConfigPath: string
}

export interface TestEnv {
  home: string
  palace: string
  destroy: () => Promise<void>
}

function resolvePluginPath(): string {
  return join(process.cwd(), "dist")
}

function resolveMempalaceBin(): string {
  const candidates = [
    join(process.env.HOME ?? "/home", ".local", "bin", "mempalace"),
    join(process.env.HOME ?? "/home", ".local", "share", "pipx", "venvs", "mempalace", "bin", "mempalace"),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return realpathSync(p)
  }
  // Fallback: hope it's on PATH
  return "mempalace"
}

export async function createTestEnv(config: TestEnvConfig): Promise<TestEnv> {
  const id = randomUUID().slice(0, 8)
  const home = `/tmp/mp-e2e-${id}`
  const palace = join(home, "palace")
  const realMempalace = resolveMempalaceBin()

  await mkdir(join(home, ".mempalace"), { recursive: true })
  await mkdir(join(home, ".local", "bin"), { recursive: true })
  await mkdir(join(home, ".local", "share", "opencode"), { recursive: true })
  await mkdir(join(home, ".config", "opencode"), { recursive: true })
  await mkdir(palace, { recursive: true })

  // Plugin config
  await writeFile(
    join(home, ".mempalace", "plugin-config.json"),
    JSON.stringify({ autoInjectContext: config.autoInjectContext }, null, 2),
    "utf-8",
  )

  // Identity
  if (config.identity) {
    await writeFile(join(home, ".mempalace", "identity.txt"), config.identity, "utf-8")
  }

  // MemPalace config — points to test palace
  await writeFile(
    join(home, ".mempalace", "config.json"),
    JSON.stringify({ palace_path: palace }, null, 2),
    "utf-8",
  )

  // Symlink mempalace binary at the location the plugin expects
  await symlink(realMempalace, join(home, ".local", "bin", "mempalace"))

  // Resolve opencode config template — replace placeholders with safe runtime values
  const opencodeConfig = await resolveConfigTemplate(config.opencodeConfigPath)
  await writeFile(join(home, ".config", "opencode", "opencode.jsonc"), opencodeConfig, "utf-8")

  // Initialize the test palace
  await execa(realMempalace, ["--palace", palace, "init"], {
    env: { HOME: home },
    timeout: 15_000,
  })

  return {
    home,
    palace,
    destroy: async () => {
      await rm(home, { recursive: true, force: true })
    },
  }
}

async function resolveConfigTemplate(templatePath: string): Promise<string> {
  const { readFile } = await import("fs/promises")
  const resolved = templatePath.startsWith("/")
    ? templatePath
    : join(process.cwd(), "e2e", "fixtures", templatePath)
  let content = await readFile(resolved, "utf-8")

  content = content.replaceAll("__PLUGIN_PATH__", resolvePluginPath())
  content = content.replaceAll("__PROXY_API_KEY__", process.env.E2E_PROXY_API_KEY ?? "")
  return content
}
