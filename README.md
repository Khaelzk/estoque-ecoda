# Estoque Ecoda

App local para importar o PDF de catálogo da Ecoda (Braswei), montar pedido por quantidade e gerar relatório.

## Requisitos

- Node.js 18+
- Python 3 (venv já incluso com PyMuPDF após o setup)

## Setup

```bash
cd estoque-ecoda
npm install
python3 -m venv .venv
.venv/bin/pip install pymupdf
```

## Rodar

```bash
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:8787

Abra o frontend, arraste o PDF (ex.: `CUTELOS 06-08.pdf`), escolha quantidades e use **Imprimir relatório** ou **Exportar CSV**.

## Parse manual

```bash
.venv/bin/python server/parse_ecoda.py "/caminho/catalogo.pdf" --out data/catalog.json --images data/images
```
