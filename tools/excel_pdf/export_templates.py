"""Extract only the three approved forms and clear every interactive field."""
import argparse
from pathlib import Path

from core import FORMS, generate, template_form

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
for form in FORMS:
    _, fields, _ = template_form(args.source, form)
    print(generate(args.source, form, dict.fromkeys(fields, ''), Path(args.output) / (form + '.pdf')))
