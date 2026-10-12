declare module "pdf-parse" {
  interface PdfParseResult { text: string; numpages: number; info?: unknown; metadata?: unknown }
  export default function pdfParse(data: Buffer, options?: Record<string, unknown>): Promise<PdfParseResult>;
}

declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult { numpages: number; text: string; }
  export default function pdfParse(data: Buffer): Promise<PdfParseResult>;
}
