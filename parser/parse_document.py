#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path

from markitdown import MarkItDown


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve(strict=True)
    source = Path(args.input).resolve(strict=True)
    if root != source and root not in source.parents:
        raise SystemExit("DOCUMENT_OUTSIDE_STAGING_ROOT")
    if source.suffix.lower() not in {".pdf", ".docx"}:
        raise SystemExit("DOCUMENT_FORMAT_UNSUPPORTED")
    text = (MarkItDown().convert(str(source)).text_content or "").strip()
    result = {
        "parser_version": "markitdown-0.1.7",
        "text": text,
        "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
