import cors from 'cors'
import express from 'express'
import multer from 'multer'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DATA_DIR = path.join(ROOT, 'data')
const IMAGES_DIR = path.join(DATA_DIR, 'images')
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
const CATALOG_PATH = path.join(DATA_DIR, 'catalog.json')
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python')
const PARSER = path.join(__dirname, 'parse_ecoda.py')

for (const dir of [DATA_DIR, IMAGES_DIR, UPLOADS_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
}

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 80 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok =
      file.mimetype === 'application/pdf' ||
      file.originalname.toLowerCase().endsWith('.pdf')
    cb(ok ? null : new Error('Envie um PDF'), ok)
  },
})

const app = express()
app.use(cors())
app.use(express.json())
app.use('/images', express.static(IMAGES_DIR))

function readCatalog() {
  if (!fs.existsSync(CATALOG_PATH)) {
    return {
      supplier: 'Ecoda',
      brand: 'Braswei',
      source: null,
      count: 0,
      available_count: 0,
      products: [],
    }
  }
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'))
}

function runParser(pdfPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      PYTHON,
      [PARSER, pdfPath, '--out', CATALOG_PATH, '--images', IMAGES_DIR],
      { cwd: ROOT },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `parser exit ${code}`))
        return
      }
      try {
        const last = stdout.trim().split('\n').filter(Boolean).at(-1)
        resolve(last ? JSON.parse(last) : { ok: true })
      } catch {
        resolve({ ok: true, raw: stdout })
      }
    })
  })
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/catalog', (_req, res) => {
  res.json(readCatalog())
})

app.get('/api/products', (req, res) => {
  const catalog = readCatalog()
  let products = catalog.products || []
  const q = String(req.query.q || '')
    .trim()
    .toLowerCase()
  const availableOnly = req.query.available === '1' || req.query.available === 'true'

  if (availableOnly) {
    products = products.filter((p) => p.available)
  }
  if (q) {
    products = products.filter(
      (p) =>
        p.code.toLowerCase().includes(q) ||
        String(p.name || '')
          .toLowerCase()
          .includes(q),
    )
  }
  res.json({
    supplier: catalog.supplier,
    brand: catalog.brand,
    source: catalog.source,
    count: products.length,
    total: catalog.count,
    available_count: catalog.available_count,
    products,
  })
})

app.post('/api/import', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'PDF obrigatório (campo pdf)' })
    return
  }

  const dest = path.join(UPLOADS_DIR, 'catalog.pdf')
  try {
    fs.renameSync(req.file.path, dest)
    const result = await runParser(dest)
    const catalog = readCatalog()
    res.json({
      ok: true,
      ...result,
      count: catalog.count,
      available_count: catalog.available_count,
      source: catalog.source,
    })
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path)
    }
    console.error(err)
    res.status(500).json({ error: err.message || String(err) })
  }
})

const PORT = Number(process.env.PORT) || 8787
app.listen(PORT, () => {
  console.log(`Ecoda API em http://localhost:${PORT}`)
})
