"""Build-time check of the isolated PDF runtime and the three blank templates."""
import tempfile
from pathlib import Path

from pypdf import PdfReader
from core import FORMS, generate, template_form

root = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory() as directory:
    for form in FORMS:
        template = root / 'assets' / 'excel-pdf' / (form + '.pdf')
        _, fields, _ = template_form(template, form)
        if any(str(field.get('/V', '')) not in ('', '/Off') for field in PdfReader(template).get_fields().values()):
            raise ValueError('Packaged templates must have no case data')
        result = generate(template, form, dict.fromkeys(fields, ''), Path(directory) / (form + '.pdf'))
        print(form, result['field_count'], 'fields verified')
