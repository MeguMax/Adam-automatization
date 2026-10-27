import tempfile
import unittest
import hashlib
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfReader
from pypdf.generic import ContentStream
from reportlab.pdfbase.pdfmetrics import stringWidth

from core import FORMS, FieldValueError, generate, page_widgets, pdf_values, text

TEMPLATES = Path(__file__).resolve().parents[2] / 'assets' / 'excel-pdf'


class CoreTests(unittest.TestCase):
    def test_excel_line_breaks_and_dates(self):
        self.assertEqual(text('First_x000D_Second'), 'First\nSecond')
        self.assertEqual(text(datetime(2026, 10, 5)), '10/5/2026')
        self.assertEqual(text(0), '0')
        self.assertEqual(text(171.54000000000002), '171.54')
        with self.assertRaises(ValueError):
            text(float('nan'))
        with self.assertRaises(ValueError):
            text(datetime(2026, 10, 5, 12))

    def convert(self, value, field_type='/Btn'):
        field = {'/FT': field_type}
        widget = {'/AP': {'/N': {'/Off': {}, '/Yes': {}}}}
        with patch('core.page_widgets', return_value=[('dc105_11', widget, field)]):
            return pdf_values(type('Writer', (), {'pages': [None]})(), {'dc105_11': field}, {'dc105_11': value})

    def test_checkboxes_use_template_export_states(self):
        for value in [True, 1, 'On', '/On', 'Yes', '/Yes', 'True', 'TRUE']:
            self.assertEqual(self.convert(value)['dc105_11'], '/Yes')
        for value in [False, 0, None, '', 'Off', '/Off', 'No', '/No', 'False', 'FALSE']:
            self.assertEqual(self.convert(value)['dc105_11'], '/Off')

    def test_ambiguous_values_and_excel_errors_stop_generation(self):
        for value in ['maybe', '1', 2, -1, '#REF!', '#VALUE!']:
            with self.assertRaises(ValueError):
                self.convert(value)
        with self.assertRaises(ValueError):
            self.convert(False, '/Tx')
        with self.assertRaises(ValueError):
            self.convert({'unexpected':'object'}, '/Tx')

    def test_existing_files_are_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'existing.pdf'
            output.write_bytes(b'original')
            with self.assertRaises(ValueError):
                generate('unused.pdf', 'dc105', {}, output)
            self.assertEqual(output.read_bytes(), b'original')

    def test_all_fields_round_trip_and_checkboxes_can_be_cleared(self):
        for form in FORMS:
            with self.subTest(form=form), tempfile.TemporaryDirectory() as folder:
                template = TEMPLATES / (form + '.pdf')
                original_hash = hashlib.sha256(template.read_bytes()).hexdigest()
                fields = PdfReader(template).get_fields()
                values = {name: True if field.get('/FT') == '/Btn' else '0'
                          for name, field in fields.items()}
                output = Path(folder) / 'filled.pdf'
                result = generate(template, form, values, output)
                self.assertEqual(result['field_count'], len(fields))
                filled = PdfReader(output)
                for page in filled.pages:
                    for name, widget, field in page_widgets(page):
                        if field.get('/FT') == '/Btn':
                            self.assertNotEqual(str(widget['/AS']), '/Off')
                            self.assertEqual(widget['/AS'], field['/V'])
                            self.assertIn(widget['/AS'], widget['/AP']['/N'])
                        else:
                            self.assertEqual(field['/V'], '0')
                cleared = Path(folder) / 'cleared.pdf'
                generate(output, form, dict.fromkeys(fields, ''), cleared)
                for page in PdfReader(cleared).pages:
                    for name, widget, field in page_widgets(page):
                        expected = '/Off' if field.get('/FT') == '/Btn' else ''
                        self.assertEqual(str(field['/V']), expected)
                        if field.get('/FT') == '/Btn':
                            self.assertEqual(str(widget['/AS']), '/Off')
                self.assertEqual(hashlib.sha256(template.read_bytes()).hexdigest(), original_hash)

    def test_long_text_and_explicit_lines_fit_without_changing_values(self):
        template = TEMPLATES / 'dc105.pdf'
        fields = PdfReader(template).get_fields()
        values = dict.fromkeys(fields, '')
        values.update(dc105_06='W' * 35, dc105_07='\n'.join('Address line ' + str(n) for n in range(8)),
                      dc105_18=0, dc105_19=171.54000000000002, dc105_24=datetime(2026, 10, 5))
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'long.pdf'
            generate(template, 'dc105', values, output)
            reader = PdfReader(output)
            actual = reader.get_fields()
            self.assertEqual(actual['dc105_06']['/V'], values['dc105_06'])
            self.assertEqual(actual['dc105_07']['/V'], values['dc105_07'])
            self.assertEqual(actual['dc105_18']['/V'], '0')
            self.assertEqual(actual['dc105_19']['/V'], '171.54')
            self.assertEqual(actual['dc105_24']['/V'], '10/5/2026')
            for page in reader.pages:
                for name, widget, _ in page_widgets(page):
                    if name not in ('dc105_06', 'dc105_07', 'dc105_19'):
                        continue
                    stream = ContentStream(widget['/AP']['/N'], reader)
                    sizes = [float(operands[1]) for operands, op in stream.operations if op == b'Tf']
                    self.assertEqual(len(sizes), 1)
                    size = sizes[0]
                    self.assertGreaterEqual(size, 7)
                    if name == 'dc105_19':
                        self.assertEqual(size, 10)
                    else:
                        self.assertLess(size, 10)
                    lines = str(actual[name]['/V']).split('\n')
                    rect = widget['/Rect']
                    self.assertLessEqual(max(stringWidth(line, 'Times-Roman', size) for line in lines),
                                         float(rect[2]) - float(rect[0]) - 4)
                    if name == 'dc105_07':
                        self.assertLessEqual(size * 1.2 * len(lines),
                                             float(rect[3]) - float(rect[1]) - 2)

    def test_unreadable_text_is_a_field_error_and_leaves_no_partial_output(self):
        template = TEMPLATES / 'dc105.pdf'
        fields = PdfReader(template).get_fields()
        for field, value in [('dc105_06', 'W' * 80), ('dc105_06', 'First\nSecond'),
                             ('dc105_07', '\n'.join(['Line'] * 30)), ('dc105_06', '\u0410'),
                             ('dc105_06', 'First\tSecond'), ('dc105_19', True)]:
            with self.subTest(field=field, value=value), tempfile.TemporaryDirectory() as folder:
                output = Path(folder) / 'invalid.pdf'
                values = dict.fromkeys(fields, '')
                values[field] = value
                with self.assertRaises(FieldValueError) as error:
                    generate(template, 'dc105', values, output)
                self.assertEqual(error.exception.field, field)
                self.assertEqual(list(Path(folder).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
