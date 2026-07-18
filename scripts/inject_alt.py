#!/usr/bin/env python3
"""inject_alt.py — アクセシブルPDFの Table / Figure 構造要素へ Alt テキストを注入する。

フェーズ4b (Agent-UA-PDF)。LuaLaTeX + tagpdf でタグ付けされた PDF に対し、
`\\Description{}` は構造ツリーへ自動反映されないため、PyMuPDF (fitz) で
Table / Figure の /Alt を後付けする(参考: ASSETS2026 fix_pdf_accessibility.py)。

使い方:
    python3 inject_alt.py <pdf_path> <alt_json_path>

alt_json_path の中身(いずれも省略可):
    {
      "tables":  ["表1の代替テキスト", "表2の代替テキスト", ...],
      "figures": ["図1の代替テキスト", ...]
    }

Table 構造要素・Figure 構造要素を「文書内の出現順(xref 昇順で近似)」で並べ、
対応する Alt を順番にセットする。リストが足りない分はスキップする。
成功時 exit 0。fitz 不在・PDF 読めない等は非ゼロ終了(サーバー側はスキップ扱い)。
"""

import sys
import json


def load_alts(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return [], []
    if not isinstance(data, dict):
        return [], []
    tables = data.get("tables") or []
    figures = data.get("figures") or []
    tables = [str(x) for x in tables if isinstance(x, (str, int, float)) and str(x).strip()]
    figures = [str(x) for x in figures if isinstance(x, (str, int, float)) and str(x).strip()]
    return tables, figures


def inject(pdf_path, table_alts, figure_alts):
    import fitz  # PyMuPDF。未インストールなら ImportError → 呼び出し側で捕捉

    doc = fitz.open(pdf_path)

    table_xrefs = []
    figure_xrefs = []
    for i in range(1, doc.xref_length()):
        try:
            s = doc.xref_get_key(i, "S")
            if s[0] == "null":
                continue
            tag = s[1].strip("/")
            if tag == "Table":
                table_xrefs.append(i)
            elif tag == "Figure":
                figure_xrefs.append(i)
        except Exception:
            continue

    n_tab = 0
    for idx, xref in enumerate(table_xrefs):
        if idx < len(table_alts):
            doc.xref_set_key(xref, "Alt", fitz.get_pdf_str(table_alts[idx]))
            n_tab += 1

    n_fig = 0
    for idx, xref in enumerate(figure_xrefs):
        if idx < len(figure_alts):
            doc.xref_set_key(xref, "Alt", fitz.get_pdf_str(figure_alts[idx]))
            n_fig += 1

    if n_tab or n_fig:
        doc.save(pdf_path, incremental=True, encryption=0)
    doc.close()
    return n_tab, n_fig, len(table_xrefs), len(figure_xrefs)


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 inject_alt.py <pdf_path> [alt_json_path]", file=sys.stderr)
        return 1
    pdf_path = sys.argv[1]
    alt_json = sys.argv[2] if len(sys.argv) > 2 else None

    table_alts, figure_alts = ([], [])
    if alt_json:
        table_alts, figure_alts = load_alts(alt_json)

    try:
        n_tab, n_fig, tot_tab, tot_fig = inject(pdf_path, table_alts, figure_alts)
    except ImportError:
        print("PyMuPDF (fitz) is not installed; skipping alt injection", file=sys.stderr)
        return 3
    except Exception as e:  # noqa: BLE001
        print("inject_alt failed: %s" % e, file=sys.stderr)
        return 2

    print(
        "Alt injected: %d/%d tables, %d/%d figures"
        % (n_tab, tot_tab, n_fig, tot_fig)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
