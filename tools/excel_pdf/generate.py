"""Local core prototype. Excel add-in integration is deliberately separate."""
import argparse
import json
from pathlib import Path

from core import FORMS, generate, row_values


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", required=True)
    parser.add_argument("--form", choices=FORMS, required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--workbook")
    source.add_argument("--values-json", help="Calculated field values supplied by Excel")
    parser.add_argument("--row", type=int)
    parser.add_argument("--sheet", default="Working Document")
    parser.add_argument("--accept-cached-values", action="store_true")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.workbook:
        if not args.row:
            parser.error("--workbook requires --row")
        if not args.accept_cached_values:
            parser.error("Recalculate and save in Excel, then explicitly use --accept-cached-values. This tool cannot verify cache freshness.")
        snapshot = row_values(args.workbook, args.row, args.sheet)
        relevant = [issue for issue in snapshot["issues"] if issue["field"].startswith(args.form + "_")]
        if relevant:
            parser.error("Resolve mapped formula/cache issues first: " + json.dumps(relevant))
        values = snapshot["values"]
    else:
        values = json.loads(Path(args.values_json).read_text(encoding="utf-8"))
        if not isinstance(values, dict):
            parser.error("Expected a JSON object of calculated PDF field values")
    print(json.dumps(generate(args.template, args.form, values, args.output), indent=2))


if __name__ == "__main__":
    main()
