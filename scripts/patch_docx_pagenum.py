#!/usr/bin/env python3
"""Post-process Fernly audit docx page numbering (WPS compatibility).

Per docx skill references/toc.md:
 1. Remove empty <w:pgNumType/> (docx-js emits it even when no pageNumbers
    is set on the cover section; it confuses WPS).
 2. Patch footer PAGE fields with an explicit format switch:
    PAGE  ->  PAGE \\* arabic \\* MERGEFORMAT
    (\\* decimal is a docx-js enum value, NOT a Word field switch.)
"""
import re
import shutil
import sys
import zipfile

def main(path: str) -> int:
    tmp = path + ".tmp"
    patched_pgnum = 0
    patched_page = 0
    with zipfile.ZipFile(path, "r") as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/document.xml":
                text = data.decode("utf-8")
                new_text, n = re.subn(r"<w:pgNumType/>", "", text)
                patched_pgnum += n
                data = new_text.encode("utf-8")
            elif re.match(r"word/footer\d+\.xml", item.filename):
                text = data.decode("utf-8")
                new_text, n = re.subn(
                    r"(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)",
                    r"\1 PAGE \\* arabic \\* MERGEFORMAT \2",
                    text,
                )
                patched_page += n
                data = new_text.encode("utf-8")
            zout.writestr(item, data)
    shutil.move(tmp, path)
    print(f"patch_docx_pagenum: removed {patched_pgnum} empty pgNumType; "
          f"patched {patched_page} PAGE fields with arabic switch")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
