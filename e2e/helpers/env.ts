import { randomUUID } from "crypto"
import { mkdir, writeFile, symlink, rm } from "fs/promises"
import { existsSync, realpathSync } from "fs"
import { join } from "path"
import { startTestProvider } from "./test-provider.js"

export interface TestEnvConfig {
  autoInjectContext: boolean
  identity: string
  opencodeConfigPath: string
}

export interface TestEnv {
  home: string
  palace: string
  pluginEnv: Record<string, string>
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
  return "mempalace"
}

function resolveMempalacePython(): string {
  const candidates = [
    join(process.env.HOME ?? "/home", ".local", "share", "pipx", "venvs", "mempalace", "bin", "python3"),
    join(process.env.HOME ?? "/home", ".local", "share", "pipx", "venvs", "mempalace", "bin", "python"),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return realpathSync(p)
  }
  return "python3"
}

function testEnvVars(home: string): Record<string, string> {
  const pythonPath = resolveMempalacePython()
  const dbPath = join(home, ".local/share/opencode/opencode.db")
  return {
    MEMPALACE_PYTHON: pythonPath,
    MEMPALACE_BIN_PATH: resolveMempalaceBin(),
    OPENCODE_DB_PATH: dbPath,
    MEMPALACE_PLUGIN_CONFIG: join(home, ".mempalace/plugin-config.json"),
    MEMPALACE_IDENTITY_FILE: join(home, ".mempalace/identity.txt"),
  }
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

  await writeFile(
    join(home, ".mempalace", "plugin-config.json"),
    JSON.stringify({ autoInjectContext: config.autoInjectContext }, null, 2),
    "utf-8",
  )

  if (config.identity) {
    await writeFile(join(home, ".mempalace", "identity.txt"), config.identity, "utf-8")
  }

  await writeFile(
    join(home, ".mempalace", "config.json"),
    JSON.stringify({ palace_path: palace }, null, 2),
    "utf-8",
  )

  await symlink(realMempalace, join(home, ".local", "bin", "mempalace"))

  const opencodeConfig = await resolveConfigTemplate(config.opencodeConfigPath)
  await writeFile(join(home, ".config", "opencode", "opencode.jsonc"), opencodeConfig, "utf-8")

  return {
    home,
    palace,
    pluginEnv: testEnvVars(home),
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

  const providerPort = await startTestProvider()
  content = content.replaceAll("__PLUGIN_PATH__", resolvePluginPath())
  content = content.replaceAll("__PROVIDER_PORT__", String(providerPort))
  return content
}
