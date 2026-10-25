"""Bounded, single-request adapter. Input is calculated values, never a workbook."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from core import generate


def main():
    values = json.loads(sys.stdin.buffer.read(96 * 1024 + 1))
    with tempfile.TemporaryDirectory(prefix='devlin-excel-pdf-') as directory:
        output = Path(directory) / 'form.pdf'
        generate(sys.argv[1], sys.argv[2], values, output)
        sys.stdout.buffer.write(output.read_bytes())


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
    except Exception:
        print('PDF generation failed. Please retry or contact support.', file=sys.stderr)
        sys.exit(1)
