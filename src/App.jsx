import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

const QTY_KEY = 'ecoda-order-qty'
const MARKUP_KEY = 'ecoda-sell-multiplier'

/** Multiplicadores de venda sobre o custo (ex.: 2.5 = custo R$10 vira venda R$25). */
const SELL_MULTIPLIERS = [
  { value: 2, label: '2×' },
  { value: 2.5, label: '2,5×' },
  { value: 3, label: '3×' },
]

const CATEGORIES = [
  { id: 'all', label: 'Todos' },
  { id: 'faca', label: 'Faca' },
  { id: 'canivete', label: 'Canivete' },
  { id: 'cutelo', label: 'Cutelo' },
  { id: 'facao', label: 'Facão' },
  { id: 'machado', label: 'Machado' },
  { id: 'outros', label: 'Outros' },
]

function formatBRL(value) {
  if (value == null || Number.isNaN(value)) return '—'
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function productCategory(name = '') {
  const n = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
  if (n.includes('canivete')) return 'canivete'
  if (n.includes('cutelo')) return 'cutelo'
  if (n.includes('facao')) return 'facao'
  if (n.includes('machad')) return 'machado'
  if (n.includes('faca')) return 'faca'
  return 'outros'
}

function loadQty() {
  try {
    return JSON.parse(localStorage.getItem(QTY_KEY) || '{}')
  } catch {
    return {}
  }
}

function loadMultiplier() {
  const raw = Number(localStorage.getItem(MARKUP_KEY))
  if (SELL_MULTIPLIERS.some((m) => m.value === raw)) return raw
  // migra valor antigo em % (90/100/110) para o padrão
  return 2.5
}

export default function App() {
  const [catalog, setCatalog] = useState(null)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [availableOnly, setAvailableOnly] = useState(true)
  const [qtyMap, setQtyMap] = useState(loadQty)
  const [sellMultiplier, setSellMultiplier] = useState(loadMultiplier)
  const [dragOver, setDragOver] = useState(false)

  const multiplierLabel =
    SELL_MULTIPLIERS.find((m) => m.value === sellMultiplier)?.label || `${sellMultiplier}×`

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/catalog')
      if (!res.ok) throw new Error('Falha ao carregar catálogo')
      const data = await res.json()
      setCatalog(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    localStorage.setItem(QTY_KEY, JSON.stringify(qtyMap))
  }, [qtyMap])

  useEffect(() => {
    localStorage.setItem(MARKUP_KEY, String(sellMultiplier))
  }, [sellMultiplier])

  const categoryCounts = useMemo(() => {
    const list = (catalog?.products || []).filter((p) => (availableOnly ? p.available : true))
    const counts = { all: list.length }
    for (const p of list) {
      const c = productCategory(p.name)
      counts[c] = (counts[c] || 0) + 1
    }
    return counts
  }, [catalog, availableOnly])

  const products = useMemo(() => {
    let list = catalog?.products || []
    if (availableOnly) list = list.filter((p) => p.available)
    if (category !== 'all') {
      list = list.filter((p) => productCategory(p.name) === category)
    }
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (p) =>
          p.code.toLowerCase().includes(q) ||
          String(p.name || '')
            .toLowerCase()
            .includes(q),
      )
    }
    return list
  }, [catalog, query, availableOnly, category])

  const orderItems = useMemo(() => {
    const all = catalog?.products || []
    return all
      .map((p) => {
        const qty = Number(qtyMap[p.code] || 0)
        if (qty <= 0) return null
        const unit = p.price || 0
        const subtotal = unit * qty
        const sellUnit = unit * sellMultiplier
        const sellSubtotal = sellUnit * qty
        return {
          ...p,
          qty,
          unit,
          subtotal,
          sellUnit,
          sellSubtotal,
          profit: sellSubtotal - subtotal,
        }
      })
      .filter(Boolean)
  }, [catalog, qtyMap, sellMultiplier])

  const costTotal = useMemo(
    () => orderItems.reduce((sum, item) => sum + item.subtotal, 0),
    [orderItems],
  )
  const sellTotal = useMemo(
    () => orderItems.reduce((sum, item) => sum + item.sellSubtotal, 0),
    [orderItems],
  )
  const profitTotal = sellTotal - costTotal

  function setQty(code, next) {
    const value = Math.max(0, Math.min(9999, Number(next) || 0))
    setQtyMap((prev) => {
      const copy = { ...prev }
      if (value <= 0) delete copy[code]
      else copy[code] = value
      return copy
    })
  }

  async function importPdf(file) {
    if (!file) return
    setImporting(true)
    setError('')
    try {
      const body = new FormData()
      body.append('pdf', file)
      const res = await fetch('/api/import', { method: 'POST', body })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erro no import')
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  function onDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) importPdf(file)
  }

  function exportCsv() {
    const rows = [
      [
        'codigo',
        'modelo',
        'quantidade',
        'custo_unitario',
        'custo_subtotal',
        `venda_${sellMultiplier}x_unitario`,
        `venda_${sellMultiplier}x_subtotal`,
        'lucro',
      ],
      ...orderItems.map((i) => [
        i.code,
        i.name,
        i.qty,
        i.unit.toFixed(2).replace('.', ','),
        i.subtotal.toFixed(2).replace('.', ','),
        i.sellUnit.toFixed(2).replace('.', ','),
        i.sellSubtotal.toFixed(2).replace('.', ','),
        i.profit.toFixed(2).replace('.', ','),
      ]),
      [],
      ['', '', '', '', 'CUSTO', '', costTotal.toFixed(2).replace('.', ',')],
      ['', '', '', '', `VENDA ${multiplierLabel}`, '', sellTotal.toFixed(2).replace('.', ',')],
      ['', '', '', '', 'LUCRO', '', profitTotal.toFixed(2).replace('.', ',')],
    ]
    const csv = rows.map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(';')).join('\n')
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pedido-ecoda-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const hasCatalog = (catalog?.products || []).length > 0

  return (
    <>
      <div className="app-shell no-print">
        <header className="topbar">
          <div>
            <p className="eyebrow">Fornecedor</p>
            <h1 className="brand">Ecoda</h1>
            <p className="subtitle">
              Catálogo Braswei — importe o PDF, escolha quantidades e gere o pedido
            </p>
          </div>
          <div className="stats">
            <div>
              <strong>{catalog?.count ?? 0}</strong>
              <span>itens</span>
            </div>
            <div>
              <strong>{catalog?.available_count ?? 0}</strong>
              <span>disponíveis</span>
            </div>
            <div>
              <strong>{orderItems.length}</strong>
              <span>no pedido</span>
            </div>
          </div>
        </header>

        {error && <div className="banner error">{error}</div>}

        <section className="import-panel">
          <div
            className={`dropzone ${dragOver ? 'over' : ''} ${importing ? 'busy' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <p className="drop-title">
              {importing ? 'Lendo PDF…' : 'Arraste o PDF da Ecoda aqui'}
            </p>
            <p className="drop-hint">ou selecione o arquivo do catálogo (ex.: CUTELOS)</p>
            <label className="file-btn">
              Escolher PDF
              <input
                type="file"
                accept="application/pdf,.pdf"
                disabled={importing}
                onChange={(e) => importPdf(e.target.files?.[0])}
              />
            </label>
            {catalog?.source && (
              <p className="source">Último import: {catalog.source}</p>
            )}
          </div>
        </section>

        {hasCatalog && (
          <div className="workspace">
            <section className="catalog-panel">
              <div className="toolbar">
                <input
                  className="search"
                  placeholder="Buscar código ou modelo…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={availableOnly}
                    onChange={(e) => setAvailableOnly(e.target.checked)}
                  />
                  Só disponíveis
                </label>
              </div>

              <div className="filters" role="tablist" aria-label="Tipo de produto">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="tab"
                    aria-selected={category === c.id}
                    className={`filter-chip ${category === c.id ? 'active' : ''}`}
                    onClick={() => setCategory(c.id)}
                  >
                    {c.label}
                    <span>{categoryCounts[c.id] || 0}</span>
                  </button>
                ))}
              </div>

              {loading ? (
                <p className="muted">Carregando…</p>
              ) : (
                <div className="grid">
                  {products.map((p) => {
                    const qty = qtyMap[p.code] || 0
                    const sell = p.available && p.price != null ? p.price * sellMultiplier : null
                    const added = sell != null ? sell - p.price : null
                    return (
                      <article
                        key={p.code}
                        className={`product ${p.available ? '' : 'soldout'} ${qty ? 'picked' : ''}`}
                      >
                        <div className="photo">
                          {p.image ? (
                            <img src={`/images/${p.image}`} alt={p.code} loading="lazy" />
                          ) : (
                            <div className="photo-fallback">Sem foto</div>
                          )}
                        </div>
                        <div className="meta">
                          <div className="code-row">
                            <span className="code">{p.code}</span>
                            {!p.available && <span className="badge">Esgotado</span>}
                          </div>
                          <h3>{p.name}</h3>
                          <p className="price">
                            {p.available ? formatBRL(p.price) : 'Indisponível'}
                          </p>
                          {p.available && sell != null && (
                            <p className="sell-hint">
                              Venda {multiplierLabel}: <strong>{formatBRL(sell)}</strong>
                              <span className={added >= 0 ? 'gain' : 'loss'}>
                                {added >= 0 ? '+' : ''}
                                {formatBRL(added)}
                              </span>
                            </p>
                          )}
                          {p.available && (
                            <div className="qty">
                              <button type="button" onClick={() => setQty(p.code, qty - 1)} aria-label="menos">
                                −
                              </button>
                              <input
                                type="number"
                                min="0"
                                value={qty}
                                onChange={(e) => setQty(p.code, e.target.value)}
                              />
                              <button type="button" onClick={() => setQty(p.code, qty + 1)} aria-label="mais">
                                +
                              </button>
                            </div>
                          )}
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
              {!loading && products.length === 0 && (
                <p className="muted">Nenhum produto com esse filtro.</p>
              )}
            </section>

            <aside className="order-panel">
              <h2>Pedido</h2>

              <div className="markup-box">
                <p className="markup-label">Preço de venda (multiplicador do custo)</p>
                <div className="markup-options">
                  {SELL_MULTIPLIERS.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      className={`markup-chip ${sellMultiplier === m.value ? 'active' : ''}`}
                      onClick={() => setSellMultiplier(m.value)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <p className="markup-help">
                  Ex.: custo R$ 10 → venda {formatBRL(10 * sellMultiplier)} · lucro {formatBRL(10 * sellMultiplier - 10)}
                </p>
              </div>

              {orderItems.length === 0 ? (
                <p className="muted">Escolha quantidades no catálogo.</p>
              ) : (
                <ul className="order-list">
                  {orderItems.map((item) => (
                    <li key={item.code}>
                      <div>
                        <strong>{item.code}</strong>
                        <span>{item.name}</span>
                      </div>
                      <div className="order-nums">
                        <span>
                          {item.qty} × {formatBRL(item.unit)}
                        </span>
                        <strong>{formatBRL(item.subtotal)}</strong>
                      </div>
                      <div className="order-sell">
                        <span>venda {multiplierLabel}</span>
                        <strong>{formatBRL(item.sellSubtotal)}</strong>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="totals-box">
                <div>
                  <span>Custo (compra)</span>
                  <strong>{formatBRL(costTotal)}</strong>
                </div>
                <div>
                  <span>Venda {multiplierLabel}</span>
                  <strong>{formatBRL(sellTotal)}</strong>
                </div>
                <div className={`profit-row ${profitTotal >= 0 ? 'gain' : 'loss'}`}>
                  <span>Lucro se vender tudo</span>
                  <strong>
                    {profitTotal >= 0 ? '+' : ''}
                    {formatBRL(profitTotal)}
                  </strong>
                </div>
              </div>

              <div className="order-actions">
                <button type="button" className="primary" disabled={!orderItems.length} onClick={() => window.print()}>
                  Imprimir relatório
                </button>
                <button type="button" disabled={!orderItems.length} onClick={exportCsv}>
                  Exportar CSV
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!orderItems.length}
                  onClick={() => setQtyMap({})}
                >
                  Limpar pedido
                </button>
              </div>
            </aside>
          </div>
        )}
      </div>

      <div className="report-print">
        <h1>Pedido Ecoda / Braswei</h1>
        <p>
          Data: {new Date().toLocaleString('pt-BR')}
          {catalog?.source ? ` · Fonte: ${catalog.source}` : ''}
          {` · Venda a ${multiplierLabel} do custo`}
        </p>
        <table>
          <thead>
            <tr>
              <th>Código</th>
              <th>Modelo</th>
              <th>Qtd</th>
              <th>Custo</th>
              <th>Venda {multiplierLabel}</th>
              <th>Lucro</th>
            </tr>
          </thead>
          <tbody>
            {orderItems.map((item) => (
              <tr key={item.code}>
                <td>{item.code}</td>
                <td>{item.name}</td>
                <td>{item.qty}</td>
                <td>{formatBRL(item.subtotal)}</td>
                <td>{formatBRL(item.sellSubtotal)}</td>
                <td>{formatBRL(item.profit)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Totais</td>
              <td>{formatBRL(costTotal)}</td>
              <td>{formatBRL(sellTotal)}</td>
              <td>{formatBRL(profitTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  )
}
