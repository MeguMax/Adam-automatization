import { PDF_PREVIEW_STYLE } from './pdfPreviewClient';

export function pdfPreviewHtml(documentId: string, version = ''): string {
    const source = `/api/documents/${encodeURIComponent(documentId)}/content?v=${encodeURIComponent(version)}`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PDF preview</title><style>body{margin:0}#preview{height:100dvh;display:flex}${PDF_PREVIEW_STYLE}</style></head>
<body><div id="preview"></div><script src="/assets/lucide.js"></script><script src="/assets/pdf-preview.js"></script>
<script>DevlinPdfPreview.create(document.getElementById('preview'),{source:${JSON.stringify(source)}});</script></body></html>`;
}
