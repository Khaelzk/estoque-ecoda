#!/usr/bin/env python3
"""Parse Ecoda/Braswei catalog PDF into products + images."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import pymupdf

CODE_RE = re.compile(r"BW\s?\d{4}(?:-\w+)?", re.IGNORECASE)
PRICE_RE = re.compile(
    r"R\$\s*:?\s*(\d+)(?:[,.:](\d{1,2}))?",
    re.IGNORECASE,
)
ESGOTADO_RE = re.compile(r"ESGOTADO", re.IGNORECASE)
HEADER_SKIP = re.compile(r"^(BRASWEI|FACAS|CANIVETES|&)$", re.IGNORECASE)


def normalize_code(raw: str) -> str:
    raw = raw.upper().replace(" ", "")
    m = re.match(r"(BW)(\d{4})(-\w+)?", raw)
    if not m:
        return raw
    return f"{m.group(1)}{m.group(2)}{m.group(3) or ''}"


def parse_price(text: str) -> tuple[float | None, bool]:
    if ESGOTADO_RE.search(text):
        return None, False
    m = PRICE_RE.search(text)
    if not m:
        return None, True
    whole = m.group(1)
    cents = m.group(2) or "00"
    if len(cents) == 1:
        cents = cents + "0"
    return float(f"{whole}.{cents}"), True


def clean_name(text: str) -> str:
    text = ESGOTADO_RE.sub("", text)
    text = PRICE_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip(" ,.-")
    return text


def page_images(page: pymupdf.Page) -> list[dict]:
    """Images with placement rects, sorted reading order (top→bottom, left→right)."""
    results = []
    for info in page.get_image_info(xrefs=True):
        bbox = info.get("bbox")
        xref = info.get("xref")
        if not bbox or not xref:
            continue
        x0, y0, x1, y1 = bbox
        w, h = x1 - x0, y1 - y0
        # Skip tiny icons / decorative fragments
        if w < 40 or h < 40:
            continue
        area = w * h
        results.append(
            {
                "xref": xref,
                "bbox": (x0, y0, x1, y1),
                "cx": (x0 + x1) / 2,
                "cy": (y0 + y1) / 2,
                "area": area,
            }
        )

    # Deduplicate overlapping same xref / near-identical placements
    results.sort(key=lambda im: (-im["area"], im["cy"], im["cx"]))
    kept = []
    for im in results:
        duplicate = False
        for other in kept:
            if im["xref"] == other["xref"] and abs(im["cx"] - other["cx"]) < 8 and abs(im["cy"] - other["cy"]) < 8:
                duplicate = True
                break
            # Same visual slot
            if abs(im["cx"] - other["cx"]) < 30 and abs(im["cy"] - other["cy"]) < 30:
                duplicate = True
                break
        if not duplicate:
            kept.append(im)

    # Prefer product photos: if many images, drop largest outliers only when
    # count exceeds typical 6-per-page and one is clearly a banner (rare here).
    kept.sort(key=lambda im: (round(im["cy"] / 40), im["cx"]))
    return kept


def _extract_codes(tokens: list[dict]) -> list[dict]:
    """Find product codes; handles 'BW7417' and split 'BW' + '7417'."""
    codes = []
    i = 0
    while i < len(tokens):
        t = tokens[i]["text"]
        code = None
        end = i
        bbox = (tokens[i]["x0"], tokens[i]["y0"], tokens[i]["x1"], tokens[i]["y1"])

        if CODE_RE.fullmatch(t.replace(" ", "")) or CODE_RE.fullmatch(t):
            code = normalize_code(t)
        elif t.upper() == "BW" and i + 1 < len(tokens):
            combo = f"BW{tokens[i + 1]['text']}"
            if CODE_RE.fullmatch(combo.replace(" ", "")):
                code = normalize_code(combo)
                end = i + 1
                bbox = (
                    tokens[i]["x0"],
                    tokens[i]["y0"],
                    tokens[i + 1]["x1"],
                    tokens[i + 1]["y1"],
                )
        else:
            m = CODE_RE.match(t)
            if m and t.upper().startswith("BW"):
                code = normalize_code(m.group(0))

        if code:
            codes.append(
                {
                    "code": code,
                    "x0": bbox[0],
                    "y0": bbox[1],
                    "x1": bbox[2],
                    "y1": bbox[3],
                    "token_end": end,
                }
            )
            i = end + 1
        else:
            i += 1
    return codes


def page_products(page: pymupdf.Page) -> list[dict]:
    """Extract product codes/names/prices with text positions.

    Prices often sit on the line below the code in the same column, so we
    gather words by column band rather than only until the next code token.
    """
    words = page.get_text("words")  # x0,y0,x1,y1,word,...
    if not words:
        return []

    tokens = [
        {"x0": w[0], "y0": w[1], "x1": w[2], "y1": w[3], "text": w[4]}
        for w in words
    ]
    tokens_sorted = sorted(tokens, key=lambda w: (round(w["y0"] / 8), w["x0"]))
    codes = _extract_codes(tokens_sorted)
    if not codes:
        return []

    codes.sort(key=lambda c: (round(c["y0"] / 35), c["x0"]))
    page_width = float(page.rect.width)

    # Group into rows
    rows: list[list[dict]] = []
    for c in codes:
        if not rows or abs(c["y0"] - rows[-1][0]["y0"]) > 35:
            rows.append([c])
        else:
            rows[-1].append(c)

    products = []
    for row_idx, row in enumerate(rows):
        row.sort(key=lambda c: c["x0"])
        next_row_y = rows[row_idx + 1][0]["y0"] if row_idx + 1 < len(rows) else page.rect.height
        # Price/ESGOTADO often sits a few points above the code baseline
        y_top = min(c["y0"] for c in row) - 18
        y_bot = min(next_row_y - 5, max(c["y1"] for c in row) + 55)

        for col_idx, c in enumerate(row):
            x_left = c["x0"] - 5
            if col_idx + 1 < len(row):
                x_right = row[col_idx + 1]["x0"] - 8
            else:
                x_right = page_width - 10

            parts = []
            for w in tokens:
                if w["y0"] < y_top or w["y0"] > y_bot:
                    continue
                if w["x0"] < x_left or w["x0"] >= x_right:
                    continue
                # Skip the code token(s) themselves
                if CODE_RE.fullmatch(w["text"].replace(" ", "")) or CODE_RE.fullmatch(w["text"]):
                    continue
                if w["text"].upper() == "BW":
                    continue
                if re.fullmatch(r"\d{4}(?:-\w+)?", w["text"]):
                    # likely the numeric half of a split code on this cell
                    if abs(w["y0"] - c["y0"]) < 8 and w["x0"] <= c["x1"] + 30:
                        continue
                parts.append(w["text"])

            blob = " ".join(parts)
            price, _ = parse_price(blob)
            if ESGOTADO_RE.search(blob):
                available = False
                price = None
            else:
                available = price is not None

            name = clean_name(blob)
            if not name or HEADER_SKIP.match(name):
                name = c["code"]

            products.append(
                {
                    "code": c["code"],
                    "name": name,
                    "price": price,
                    "available": available,
                    "x": c["x0"],
                    "y": c["y0"],
                    "cx": (c["x0"] + c["x1"]) / 2,
                    "cy": (c["y0"] + c["y1"]) / 2,
                }
            )

    products.sort(key=lambda p: (round(p["y"] / 40), p["x"]))
    return products


def match_images(products: list[dict], images: list[dict]) -> list[dict | None]:
    """Assign an image to each product."""
    if not products:
        return []
    if len(images) == len(products):
        return images

    used = set()
    assigned = []
    for p in products:
        best_i = None
        best_dist = float("inf")
        for idx, im in enumerate(images):
            if idx in used:
                continue
            # Prefer images above the text label (typical layout)
            dy = p["cy"] - im["cy"]
            dx = p["cx"] - im["cx"]
            # Heavily penalize images far horizontally (wrong column)
            dist = abs(dx) * 2.5 + abs(dy)
            # Prefer image whose bottom is above or near the text
            if im["bbox"][3] > p["y"] + 30:
                dist += 80
            if dist < best_dist:
                best_dist = dist
                best_i = idx
        if best_i is not None and best_dist < 500:
            used.add(best_i)
            assigned.append(images[best_i])
        else:
            assigned.append(None)
    return assigned


def save_image(doc: pymupdf.Document, xref: int, dest: Path) -> bool:
    try:
        pix = pymupdf.Pixmap(doc, xref)
        if pix.n > 4:  # CMYK etc
            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
        if dest.suffix.lower() in {".jpg", ".jpeg"}:
            pix.save(dest.as_posix(), output="jpeg", jpg_quality=85)
        else:
            pix.save(dest.as_posix())
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"warn: failed to save xref {xref}: {exc}", file=sys.stderr)
        return False


def parse_pdf(pdf_path: Path, images_dir: Path) -> dict:
    images_dir.mkdir(parents=True, exist_ok=True)
    # Clear old images for a clean re-import
    for old in images_dir.glob("*"):
        if old.is_file():
            old.unlink()

    doc = pymupdf.open(pdf_path)
    by_code: dict[str, dict] = {}

    for page_index in range(len(doc)):
        page = doc[page_index]
        products = page_products(page)
        images = page_images(page)
        matched = match_images(products, images)

        for prod, im in zip(products, matched):
            image_file = None
            if im is not None:
                safe = re.sub(r"[^\w\-]", "_", prod["code"])
                image_file = f"{safe}.jpg"
                dest = images_dir / image_file
                if not save_image(doc, im["xref"], dest):
                    image_file = None

            by_code[prod["code"]] = {
                "code": prod["code"],
                "name": prod["name"],
                "price": prod["price"],
                "available": prod["available"],
                "image": image_file,
                "page": page_index + 1,
                "supplier": "Ecoda",
                "brand": "Braswei",
            }

    doc.close()
    products_list = sorted(by_code.values(), key=lambda p: p["code"])
    return {
        "supplier": "Ecoda",
        "brand": "Braswei",
        "source": pdf_path.name,
        "count": len(products_list),
        "available_count": sum(1 for p in products_list if p["available"]),
        "products": products_list,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Parse Ecoda Braswei catalog PDF")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--out", type=Path, required=True, help="catalog.json path")
    parser.add_argument("--images", type=Path, required=True, help="images directory")
    args = parser.parse_args()

    if not args.pdf.exists():
        print(f"error: PDF not found: {args.pdf}", file=sys.stderr)
        return 1

    catalog = parse_pdf(args.pdf, args.images)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "count": catalog["count"], "available": catalog["available_count"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
