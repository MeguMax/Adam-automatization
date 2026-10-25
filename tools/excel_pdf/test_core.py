import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from core import generate, pdf_values, text


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
        for value in [True, 'On', '/On', 'Yes']:
            self.assertEqual(self.convert(value)['dc105_11'], '/Yes')
        for value in [False, None, '', 'Off']:
            self.assertEqual(self.convert(value)['dc105_11'], '/Off')

    def test_ambiguous_values_and_excel_errors_stop_generation(self):
        for value in ['maybe', '#REF!', '#VALUE!']:
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


if __name__ == '__main__':
    unittest.main()
