import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nodemailer from 'nodemailer'
import dotenv from 'dotenv'
import fsSync from 'node:fs'
import cors from "cors";

const app = express()


app.use(express.json({ limit: '100kb' }))

app.use(cors());
// Load .env (robust to different working directories; Windows users sometimes save it as UTF-16)
const serverDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(serverDir, '..')
const envCandidates = [
  path.join(process.cwd(), '.env'),
  path.join(projectRoot, '.env'),
]
let loadedEnvFrom = null
let parsedEnvKeys = []
let envTailKeys = []
let envKeyDiagnostics = []

// ----------------------------------------------------------

// const PORT = process.env.PORT || 3000;

// import path from "path";

// const __dirname = new URL('.', import.meta.url).pathname;

// app.use(express.static(path.join(__dirname, "../dist")));

// app.get("*", (req, res) => {
//   res.sendFile(path.join(__dirname, "../dist/index.html"));
// });

// ------------------------------------------------------

// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });

function normalizeEnvKey(raw) {
  // Handle common Cyrillic confusables that look like Latin in editors:
  // АВСЕНКМОРТХУ (and lowercase variants)
  const map = new Map([
    ['А', 'A'],
    ['В', 'B'],
    ['С', 'C'],
    ['Е', 'E'],
    ['Н', 'H'],
    ['К', 'K'],
    ['М', 'M'],
    ['О', 'O'],
    ['Р', 'P'],
    ['Т', 'T'],
    ['Х', 'X'],
    ['У', 'Y'],
    ['а', 'a'],
    ['в', 'b'],
    ['с', 'c'],
    ['е', 'e'],
    ['н', 'h'],
    ['к', 'k'],
    ['м', 'm'],
    ['о', 'o'],
    ['р', 'p'],
    ['т', 't'],
    ['х', 'x'],
    ['у', 'y'],
  ])

  let out = ''
  for (const ch of String(raw)) out += map.get(ch) ?? ch
  return out
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/\u0000/g, '')
    .replace(/[^A-Za-z0-9_]/g, '')
}

function applyParsedEnv(text) {
  const keys = []
  const normalized = String(text)
    .replace(/^\uFEFF/, '') // strip BOM
    .replace(/\u0000/g, '') // handle UTF-16 text decoded incorrectly

  const lines = normalized.split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = normalizeEnvKey(trimmed.slice(0, eq))
    let value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/\u0000/g, '')
    if (!key) continue
    keys.push(key)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }

  return keys
}

function tryLoadEnvFile(envPath) {
  if (!fsSync.existsSync(envPath)) return

  // First try dotenv (normal case)
  dotenv.config({ path: envPath })
  if (process.env.SMTP_HOST) {
    loadedEnvFrom = envPath
    return
  }

  // Fallback: read & parse manually (handles odd encodings/BOM)
  try {
    const buf = fsSync.readFileSync(envPath)
    let text = null

    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      // UTF-16LE BOM
      text = buf.slice(2).toString('utf16le')
    } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      // UTF-16BE BOM (swap bytes then decode as LE)
      const swapped = Buffer.allocUnsafe(buf.length - 2)
      for (let i = 2; i < buf.length; i += 2) {
        swapped[i - 2] = buf[i + 1]
        swapped[i - 1] = buf[i]
      }
      text = swapped.toString('utf16le')
    } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      // UTF-8 BOM
      text = buf.slice(3).toString('utf8')
    } else {
      // try UTF-8 first; if it contains many NULs, interpret as UTF-16LE
      const utf8 = buf.toString('utf8')
      const nulCount = (utf8.match(/\u0000/g) || []).length
      text = nulCount > 4 ? buf.toString('utf16le') : utf8
    }

    const keys = applyParsedEnv(text)
    if (keys.length) parsedEnvKeys = keys
    if (process.env.SMTP_HOST) loadedEnvFrom = envPath

    // Capture tail keys for debugging (keys only, no values)
    const normalized = String(text)
      .replace(/^\uFEFF/, '')
      .replace(/\u0000/g, '')
    const tail = normalized.split(/\r?\n/).slice(-30)
    envTailKeys = tail
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => normalizeEnvKey(l.split('=')[0]))

    // Key diagnostics (no values): raw key, normalized key, code points
    const allLines = normalized.split(/\r?\n/).slice(0, 120)
    envKeyDiagnostics = allLines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const rawKey = l.split('=')[0].trim().replace(/^\uFEFF/, '')
        const normalizedKey = normalizeEnvKey(rawKey)
        const cps = Array.from(rawKey)
          .slice(0, 40)
          .map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
        return { rawKey: rawKey.slice(0, 80), normalizedKey, codePoints: cps }
      })
  } catch {
    /* ignore */
  }
}

for (const envPath of envCandidates) {
  tryLoadEnvFile(envPath)
  if (process.env.SMTP_HOST) break
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

const port = Number(process.env.PORT || 8787)
const submissionsFile = path.join(process.cwd(), 'server', 'submissions.jsonl')

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/debug-env', (_req, res) => {
  res.json({
    ok: true,
    loadedEnvFrom,
    cwd: process.cwd(),
    envCandidates: envCandidates.map((p) => ({
      path: p,
      exists: fsSync.existsSync(p),
    })),
    parsedEnvKeys: parsedEnvKeys.slice(0, 50),
    envTailKeys: envTailKeys.slice(0, 50),
    envKeyDiagnostics: envKeyDiagnostics.slice(0, 50),
    has: {
      SMTP_HOST: Boolean(process.env.SMTP_HOST),
      SMTP_PORT: Boolean(process.env.SMTP_PORT),
      SMTP_USER: Boolean(process.env.SMTP_USER),
      SMTP_PASS: Boolean(process.env.SMTP_PASS),
      MAIL_FROM: Boolean(process.env.MAIL_FROM),
      MAIL_TO: Boolean(process.env.MAIL_TO),
    },
  })
})

app.get('/api/submissions', async (_req, res) => {
  try {
    const raw = await fs.readFile(submissionsFile, 'utf8')
    const items = raw
      .split('\n')
      .filter(Boolean)
      .slice(-50)
      .map((line) => JSON.parse(line))
      .reverse()
    res.json({ ok: true, items })
  } catch (err) {
    if (err?.code === 'ENOENT') {
      res.json({ ok: true, items: [] })
      return
    }
    console.error(err)
    res.status(500).json({ ok: false, error: 'read_failed' })
  }
})

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, plz, message } = req.body ?? {}

    if (
      typeof name !== 'string' ||
      typeof email !== 'string' ||
      typeof message !== 'string' ||
      !name.trim() ||
      !email.trim() ||
      !message.trim()
    ) {
      res.status(400).json({ ok: false, error: 'invalid_payload' })
      return
    }

    const transporter = nodemailer.createTransport({
      host: requireEnv('SMTP_HOST'),
      port: Number(requireEnv('SMTP_PORT')),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: {
        user: requireEnv('SMTP_USER'),
        pass: requireEnv('SMTP_PASS'),
      },
    })

    const to = process.env.MAIL_TO || 'kuizveb@gmail.com'
    const from = requireEnv('MAIL_FROM')

    const subject = `FensterPro: Kontaktanfrage von ${name}`
    const text = [
      `Name: ${name}`,
      `Email: ${email}`,
      `PLZ/Ort: ${typeof plz === 'string' ? plz : ''}`,
      '',
      'Nachricht:',
      message,
    ].join('\n')

    await transporter.sendMail({
      from,
      to,
      replyTo: email,
      subject,
      text,
    })

    const saved = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      name,
      email,
      plz: typeof plz === 'string' ? plz : '',
      message,
    }
    await fs.mkdir(path.dirname(submissionsFile), { recursive: true })
    await fs.appendFile(submissionsFile, `${JSON.stringify(saved)}\n`, 'utf8')

    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ ok: false, error: 'send_failed' })
  }
})
// -------------------------
const __dirname = new URL('.', import.meta.url).pathname;

app.use(express.static(path.join(__dirname, "../dist")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../dist/index.html"));
});
// -------------------------------

app.listen(port, () => {
  console.log(`[mail-server] listening on http://localhost:${port}`)
})

