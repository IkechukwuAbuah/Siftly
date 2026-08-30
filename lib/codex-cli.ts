import { execFile, spawn } from 'child_process'
import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'


export interface CodexCliOptions {
  model?: string
  timeoutMs?: number
}

export interface CodexCliResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export async function isCodexCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('codex', ['--version'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    const timeout = setTimeout(() => { proc.kill(); resolve(false) }, 5000)
    proc.on('close', (code) => { clearTimeout(timeout); resolve(code === 0) })
    proc.on('error', () => { clearTimeout(timeout); resolve(false) })
  })
}

/**
 * Run `codex` and capture its output.
 *
 * `codex exec` reads extra prompt input from stdin whenever stdin is not a TTY.
 * execFile hands the child an open stdin pipe that nothing ever writes to or
 * closes, so codex waited on it forever, never started a session, and was
 * killed at the timeout — producing an empty result. Closing stdin immediately
 * gives codex the EOF it is waiting for.
 */
function runCodexExec(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'codex',
      args,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      },
    )
    child.stdin?.end()
  })
}

export async function codexPrompt(
  prompt: string,
  options: CodexCliOptions = {}
): Promise<CodexCliResult<string>> {
  const { model, timeoutMs = 120_000 } = options

  // Write output to a temp file so we can capture the model's final message cleanly
  const outFile = join(tmpdir(), `codex-out-${randomUUID()}.txt`)

  // --ignore-user-config skips the user's ~/.codex/config.toml (skills, hooks, MCP
  // servers). None of it is relevant to a self-contained prompt-to-JSON call, and
  // loading it measured 46s vs 16s for the same prompt. Auth still resolves from
  // CODEX_HOME, so the ChatGPT subscription is unaffected.
  const args = ['exec', '--ignore-user-config', '--output-last-message', outFile]
  if (model) args.push('--model', model)
  args.push(prompt)

  try {
    const { stderr } = await runCodexExec(args, timeoutMs)

    // Read the captured output
    try {
      const output = readFileSync(outFile, 'utf8').trim()
      try { unlinkSync(outFile) } catch { /* ignore cleanup errors */ }
      return { success: true, data: output }
    } catch {
      try { unlinkSync(outFile) } catch { /* ignore */ }
      // codex exited cleanly but produced no final message. Its stderr is the
      // only clue as to why, so surface a tail of it instead of discarding it.
      const detail = (stderr || '').trim().slice(-500)
      return {
        success: false,
        error: `Codex exec completed but no output file found${detail ? ` — codex stderr: ${detail}` : ' (codex produced no stderr)'}`,
      }
    }
  } catch (err) {
    // If the process ran but output was written before the error, try reading it
    try {
      const output = readFileSync(outFile, 'utf8').trim()
      try { unlinkSync(outFile) } catch { /* ignore */ }
      if (output) {
        return { success: true, data: output }
      }
    } catch { /* no output file */ }

    try { unlinkSync(outFile) } catch { /* ignore */ }
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

let _cliAvailable: boolean | null = null
let _cliCheckTime = 0
let _cliCheckPromise: Promise<boolean> | null = null
const CLI_CHECK_TTL_MS = 60_000

export async function getCodexCliAvailability(): Promise<boolean> {
  const now = Date.now()
  if (_cliAvailable !== null && now - _cliCheckTime < CLI_CHECK_TTL_MS) return _cliAvailable
  if (_cliCheckPromise) return _cliCheckPromise

  _cliCheckPromise = isCodexCliAvailable().then((result) => {
    _cliAvailable = result
    _cliCheckTime = Date.now()
    _cliCheckPromise = null
    return result
  })
  return _cliCheckPromise
}
