// plugins/nova-guards — исполняет в OpenCode V2 механизмы `.claude/settings.json`
// ТОГО репозитория, где открыта сессия.
//
// ЗАЧЕМ (реестр nova 221.1 №1715, замер 2026-10-03). В OpenCode хуки Claude Code
// не исполняются: `guard-git.py` не судил ни одной команды, список запретов
// (чтение секретов, `git reset --hard`, `git clean -fd`) не действовал.
//
// КАК. Дом правил один — `.claude/settings.json` репозитория; плагин читает его
// при каждом вызове и копии не держит:
//   * хуки `PreToolUse` для оболочки — те же скрипты, код 2 = отказ с их текстом;
//   * `permissions.deny`: `Read(...)` — запрет чтения по маске, `Bash(...)` /
//     `PowerShell(...)` — запрет команды по префиксу (`git -C <путь>` срезается
//     перед сравнением, иначе `git -C . reset --hard` проходил бы мимо);
//   * слэш-команды из `.claude/commands/*.md` — шаблон читается при вызове.
// Репозиторий берётся от каталога сессии (`git rev-parse --show-toplevel`); где
// `.claude/settings.json` нет, плагин ничего не делает.
//
// ЧЕГО НЕ ДЕЛАЕТ: хуки `Write`, `Stop`, `SessionStart`, `PostToolUse` — у OpenCode
// нет их точного аналога (время и окружение — плагин nova-env). Определения
// субагентов Claude Code API плагина добавить не позволяет; их держат указатели в
// `.opencode/` самого репозитория.
//
// Сбой САМОГО плагина пропускает команду (как у хуков Claude Code) и пишется в
// журнал `<tmp>/nova-opencode-plugins.log`.

import { execFileSync, spawn } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const LOG = path.join(os.tmpdir(), "nova-opencode-plugins.log")
const HOOK_TIMEOUT_MS = 20_000

function log(line: string) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} nova-guards ${line}\n`)
  } catch {}
}

const posix = (p: string) => p.replace(/\\/g, "/")

// ── репозиторий сессии ───────────────────────────────────────────────────────

const topCache = new Map<string, string | null>()

function repoTop(dir: string): string | undefined {
  if (!dir) return undefined
  if (topCache.has(dir)) return topCache.get(dir) ?? undefined
  let top: string | null = null
  try {
    top = path.resolve(execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true }).trim())
  } catch {
    top = null
  }
  topCache.set(dir, top)
  return top ?? undefined
}

function readSettings(root: string): any | undefined {
  const file = path.join(root, ".claude", "settings.json")
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch (e) {
    log(`settings unreadable ${file}: ${e}`)
    return undefined
  }
}

// ── хуки PreToolUse ─────────────────────────────────────────────────────────

function preToolCommands(settings: any, tool: string): string[] {
  const out: string[] = []
  for (const entry of settings?.hooks?.PreToolUse ?? []) {
    let re: RegExp
    try {
      re = new RegExp(`^(?:${entry.matcher ?? ".*"})$`)
    } catch {
      continue
    }
    if (!re.test(tool)) continue
    for (const h of entry.hooks ?? []) if (h.type === "command" && h.command) out.push(h.command)
  }
  return out
}

function runHook(root: string, command: string, payload: unknown, sessionID: string): Promise<{ code: number; stderr: string }> {
  const cmd = command.replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, posix(root))
  return new Promise((resolve) => {
    let stderr = ""
    let done = false
    const finish = (code: number) => {
      if (done) return
      done = true
      resolve({ code, stderr })
    }
    try {
      const child = spawn(cmd, {
        cwd: root,
        shell: true,
        windowsHide: true,
        env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_CODE_SESSION_ID: sessionID, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      })
      const timer = setTimeout(() => {
        log(`hook timeout: ${cmd}`)
        child.kill()
        finish(0)
      }, HOOK_TIMEOUT_MS)
      child.stderr?.on("data", (d) => (stderr += d.toString("utf8")))
      child.on("error", (e) => {
        clearTimeout(timer)
        log(`hook spawn failed: ${cmd}: ${e}`)
        finish(0)
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        finish(code ?? 0)
      })
      child.stdin?.end(JSON.stringify(payload))
    } catch (e) {
      log(`hook crashed: ${cmd}: ${e}`)
      finish(0)
    }
  })
}

// ── permissions.deny ────────────────────────────────────────────────────────

type DenyRule = { tool: string; pattern: string }

function denyRules(settings: any): DenyRule[] {
  const out: DenyRule[] = []
  for (const raw of settings?.permissions?.deny ?? []) {
    const m = /^(\w+)\((.*)\)$/.exec(String(raw))
    if (m) out.push({ tool: m[1], pattern: m[2] })
  }
  return out
}

function globToRegExp(glob: string): RegExp {
  const g = posix(glob).replace(/^\.\//, "")
  let re = ""
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === "*" && g[i + 1] === "*") {
      re += g[i + 2] === "/" ? "(?:.*/)?" : ".*"
      i += g[i + 2] === "/" ? 2 : 1
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`, "i")
}

function readDenied(root: string, rules: DenyRule[], file: string): string | undefined {
  const r = posix(root)
  const abs = posix(path.resolve(root, file))
  const rel = abs.toLowerCase().startsWith(r.toLowerCase() + "/") ? abs.slice(r.length + 1) : abs
  for (const rule of rules) {
    if (rule.tool !== "Read") continue
    if (globToRegExp(rule.pattern).test(rel)) return `Read(${rule.pattern})`
  }
  return undefined
}

function normalizeSegment(seg: string): string {
  return seg
    .trim()
    .replace(/^git((?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))+)/, "git")
    .replace(/\s+/g, " ")
}

function shellDenied(rules: DenyRule[], command: string): string | undefined {
  const segments = command.split(/&&|\|\||;|\||\r?\n/).map(normalizeSegment).filter(Boolean)
  for (const r of rules) {
    if (r.tool !== "Bash" && r.tool !== "PowerShell") continue
    const prefix = r.pattern.replace(/:\*$/, "").replace(/\s+/g, " ").trim()
    if (segments.some((s) => s.startsWith(prefix))) return `${r.tool}(${r.pattern})`
  }
  return undefined
}

function shellCommandOf(ev: any): string {
  const meta = ev?.metadata ?? {}
  if (typeof meta.command === "string" && meta.command) return meta.command
  const res: string[] = Array.isArray(ev?.resources) ? ev.resources : []
  return res.join("\n")
}

// ── команды ─────────────────────────────────────────────────────────────────

function commandFiles(root: string): { name: string; file: string; description: string }[] {
  const dir = path.join(root, ".claude", "commands")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const file = path.join(dir, f)
      const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? ""
      const description = /^description:\s*"?(.*?)"?\s*$/m.exec(head)?.[1] ?? ""
      return { name: f.slice(0, -3), file, description }
    })
}

const commandBody = (file: string) => readFileSync(file, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")

// ── плагин ──────────────────────────────────────────────────────────────────

export default {
  id: "nova.guards",
  async setup(ctx: any) {
    const sessionDir = new Map<string, string>()

    async function rootOf(sessionID: string): Promise<string | undefined> {
      let dir = sessionDir.get(sessionID)
      if (!dir) {
        try {
          const r = await ctx.session.get({ sessionID })
          const info = r?.data ?? r
          dir = String(info?.location?.directory ?? "")
        } catch {
          dir = ""
        }
        if (!dir) dir = String(ctx?.location?.directory ?? "")
        sessionDir.set(sessionID, dir)
      }
      return repoTop(dir)
    }

    await ctx.permission.hook("evaluate", async (ev: any) => {
      try {
        if (ev.effect === "deny") return
        if (ev.action !== "read" && ev.action !== "shell") return
        const root = await rootOf(String(ev.sessionID ?? ""))
        if (!root) return
        const settings = readSettings(root)
        if (!settings) return
        const rules = denyRules(settings)
        if (ev.action === "read") {
          for (const f of ev.resources ?? []) {
            const hit = readDenied(root, rules, String(f))
            if (hit) {
              ev.effect = "deny"
              ev.message = `nova-guards: ${hit} (${path.basename(root)}/.claude/settings.json permissions.deny)`
              log(`deny read ${f} by ${hit} in ${root}`)
              return
            }
          }
          return
        }
        const command = shellCommandOf(ev)
        if (!command) return
        const hit = shellDenied(rules, command)
        if (hit) {
          ev.effect = "deny"
          ev.message = `nova-guards: ${hit} (${path.basename(root)}/.claude/settings.json permissions.deny)`
          log(`deny shell by ${hit} in ${root}: ${command}`)
          return
        }
        const payload = { session_id: ev.sessionID, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: root }
        for (const hook of preToolCommands(settings, "Bash")) {
          const r = await runHook(root, hook, payload, String(ev.sessionID ?? ""))
          if (r.code === 2) {
            ev.effect = "deny"
            ev.message = r.stderr.trim() || `nova-guards: refused by ${hook}`
            log(`deny shell by hook ${hook} in ${root}: ${command}`)
            return
          }
        }
      } catch (e) {
        log(`evaluate failed: ${e}`)
      }
    })

    // Команды — от каталога, где загружен экземпляр плагина (OpenCode грузит
    // глобальный плагин на каждое расположение отдельно).
    try {
      const root = repoTop(String(ctx?.location?.directory ?? ""))
      const cmds = root ? commandFiles(root) : []
      if (cmds.length) {
        const existing = new Set<string>()
        try {
          const list = await ctx.command.list()
          for (const c of list?.data ?? list ?? []) if (c?.name) existing.add(String(c.name))
        } catch {}
        const fresh = cmds.filter((c) => !existing.has(c.name))
        await ctx.command.transform((editor: any) => {
          for (const c of fresh) {
            editor.add({
              name: c.name,
              description: c.description,
              execute: async ({ sessionID, prompt, delivery }: any) => {
                const text = commandBody(c.file).split("$ARGUMENTS").join(prompt?.text ?? "")
                await ctx.session.prompt({ ...prompt, sessionID, text, delivery })
              },
            })
          }
        })
        log(`commands from ${root}: ${fresh.length}`)
      }
    } catch (e) {
      log(`commands failed: ${e}`)
    }
  },
}
