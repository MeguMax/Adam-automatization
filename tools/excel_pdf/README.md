# Excel-to-PDF core prototype

This is separate from the production email/Draft workflow. It does not install an
Excel add-in, save to OneDrive through Graph, send email, or access MiFILE.

The first forms are DC105 Judgment, DC508 Conditional Dismissal (both pages), and
MC202 Certification of Records. The original PDF is never overwritten. Output
retains interactive fields and is reopened to verify canonical values, widget
values, appearances, and page/field coverage.

The engine copies existing field values. It does not choose legal answers or
signatures. US date formatting follows the supplied completed examples. PDF font
resources are retained, including the standard Times-Roman alias used by these
templates. Every selected form field must have an exact matching workbook header.

Install `requirements.txt` in a separate Python environment. The supplied workbook
is read-only. The generator maps exact PDF field names to the calculated columns;
it never runs macros or evaluates Excel formulas itself.

```powershell
python tools/excel_pdf/audit.py --workbook "input.xlsx" --template "forms.pdf" --examples "example.pdf" --output-json "output/audit.json"
python tools/excel_pdf/generate.py --template "forms.pdf" --form dc105 --workbook "input.xlsx" --row 83 --accept-cached-values --output "output/pdf/example-dc105.pdf"
```

Recalculate and save the workbook in Excel before accepting cached values. Cache
freshness cannot be verified from XLSX alone. Missing caches, mapped Excel errors,
unknown checkbox values, missing/duplicate headers, and ambiguous form structures
stop generation. Existing unrelated workbook errors are reported, not repaired.

The preferred future add-in boundary is a calculated field-value JSON object,
obtained from the selected row in the running Excel application:

```powershell
python tools/excel_pdf/generate.py --template "forms.pdf" --form dc105 --values-json "calculated-fields.json" --output "output/pdf/example-dc105.pdf"
```

The Office.js task-pane adapter now lives in `excel-addin/` and uses calculated
values from the running Excel host, not XLSX caches. See `EXCEL_PDF_ADDIN.md` for
installation, runtime boundaries and verification status. Its current save action
is an explicit download. Automatic OneDrive delivery and the first native Office
installation still need verification/integration.

Microsoft's selected-range API reference:
https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-workbooks#get-the-active-cell-or-selected-range

Run the core guards with `python -m unittest discover -s tools/excel_pdf`.
