"""CLI: python -m workspace_manifest validate <manifest.json> [--adapters registry.json] [--json]

Exit code 0 = no errors (warnings allowed), 1 = errors, 2 = usage / unreadable input.
"""
import argparse
import json
import sys

from .validate import validate


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="workspace_manifest")
    sub = p.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate", help="validate a workspace manifest")
    v.add_argument("file")
    v.add_argument("--adapters", help="adapter registry JSON {key: {versions: [...], hooks: [...]}}")
    v.add_argument("--json", action="store_true", help="print the full report as JSON")
    a = p.parse_args(argv)
    try:
        manifest = json.load(open(a.file, encoding="utf-8"))
        adapters = json.load(open(a.adapters, encoding="utf-8")) if a.adapters else None
    except (OSError, ValueError) as exc:
        print(f"cannot read input: {exc}", file=sys.stderr)
        return 2
    rep = validate(manifest, adapters=adapters)
    if a.json:
        print(json.dumps(rep, indent=2, ensure_ascii=False))
    else:
        for f in rep["findings"]:
            where = " ".join(f"{k}={f[k]}" for k in ("module", "stage", "field") if k in f)
            print(f"{f['severity'].upper():7} {f['rule']:>3} {f['code']:<30} {f['message']}  [{f['path']}{' ' + where if where else ''}]")
        print(f"{'OK' if rep['ok'] else 'REFUSED'}: {rep['errors']} error(s), {rep['warnings']} warning(s)")
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
