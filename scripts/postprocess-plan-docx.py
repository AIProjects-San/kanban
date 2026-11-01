#!/usr/bin/env python3
"""Post-process Fernly plan docx: patch footer PAGE field format switches
(WPS compatibility) and remove empty <w:pgNumType/> from the cover section."""
import re
import shutil
import sys
import zipfile
from pathlib import Path

DOCX = Path("/home/z/my-project/download/Fernly-Board-Enhancement-Plan.docx")
TMP = Path("/tmp/docx-postprocess")

def main():
    if TMP.exists():
        shutil.rmtree(TMP)
    TMP.mkdir(parents=True)
    with zipfile.ZipFile(DOCX) as z:
        z.extractall(TMP)

    # 1) document.xml — remove empty pgNumType (cover section)
    doc_path = TMP / "word" / "document.xml"
    xml = doc_path.read_text(encoding="utf-8")
    before = xml.count("<w:pgNumType/>")
    xml = xml.replace("<w:pgNumType/>", "")
    doc_path.write_text(xml, encoding="utf-8")
    print(f"removed {before} empty <w:pgNumType/>")

    # 2) footers — the roman footer belongs to section 2 (footer of the TOC
    # section) and the arabic footer to section 3 (body). docx-js emits
    # footer files in order of definition; identify by sectPr references.
    # Simpler robust approach: find which footer rIds are referenced by which
    # sectPr in document.xml, map rId -> footerN.xml via word/_rels.
    rels = (TMP / "word" / "_rels" / "document.xml.rels").read_text(encoding="utf-8")
    rid_to_target = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="(footer\d+\.xml)"', rels))

    # sectPr blocks in order; extract footerReference ids per sectPr
    sectprs = re.findall(r"<w:sectPr.*?</w:sectPr>|<w:sectPr[^>]*/>", xml, re.S)
    print(f"found {len(sectprs)} sectPr blocks")
    footer_fmt = {}  # footer file -> 'ROMAN' | 'arabic'
    for i, sp in enumerate(sectprs):
        fmt_m = re.search(r'<w:pgNumType[^>]*w:fmt="([^"]+)"', sp)
        fmt = fmt_m.group(1) if fmt_m else None
        for rid in re.findall(r'<w:footerReference[^>]*r:id="(rId\d+)"', sp):
            target = rid_to_target.get(rid)
            if not target:
                continue
            if fmt == "upperRoman":
                footer_fmt[target] = "ROMAN"
            elif fmt in ("decimal", None):
                footer_fmt[target] = "arabic"
        print(f"  sectPr[{i}]: fmt={fmt}, footers={[rid_to_target.get(r) for r in re.findall(chr(114)+'id=\"(rId[0-9]+)\"', sp)]}")

    for target, fmt in footer_fmt.items():
        fpath = TMP / "word" / target
        if not fpath.exists():
            continue
        fxml = fpath.read_text(encoding="utf-8")
        # replace bare PAGE instrText with explicit format switch
        new_xml, n = re.subn(
            r"(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)",
            rf"\1 PAGE \\* {fmt} \\* MERGEFORMAT \2",
            fxml,
        )
        if n:
            fpath.write_text(new_xml, encoding="utf-8")
            print(f"patched {target}: PAGE -> PAGE \\* {fmt} (x{n})")
        else:
            print(f"{target}: no bare PAGE field found (n=0)")

    # 3) rezip
    out = DOCX
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(TMP.rglob("*")):
            if p.is_file():
                z.write(p, p.relative_to(TMP).as_posix())
    print(f"rewrote {out}")

if __name__ == "__main__":
    sys.exit(main())
