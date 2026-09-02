import PDFDocument from "pdfkit";

/**
 * Form 16A stub (brief §4): a PDF carrying the fields a TDS certificate
 * needs, watermarked "DRAFT" until a CA confirms 194H vs 194-O (H-18,
 * `RR-05-payments-tax.md`) — `affiliate_tds_section` only controls this
 * watermark, never the withheld rate (`tds.ts`'s doc-comment).
 */
export interface Form16aInput {
  readonly affiliateLegalName: string;
  readonly affiliatePan: string | null;
  readonly fyLabel: string;
  readonly tdsSection: string;
  readonly grossMinor: number;
  readonly tdsMinor: number;
  readonly netMinor: number;
  readonly deductorName: string;
  readonly deductorTan?: string;
  readonly draft: boolean;
}

function formatRupees(minor: number): string {
  return `₹${(minor / 100).toFixed(2)}`;
}

export async function renderForm16aPdf(input: Form16aInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (input.draft) {
      doc
        .fontSize(9)
        .fillColor("red")
        .text("DRAFT — pending CA confirmation of TDS section (194H vs 194-O)", {
          align: "center",
        });
      doc.moveDown();
      doc.fillColor("black");
    }

    doc
      .fontSize(16)
      .text("Form 16A (TDS certificate) — Aksharo affiliate commission", { align: "center" });
    doc.moveDown();
    doc.fontSize(11);
    doc.text(
      `Deductor: ${input.deductorName}${input.deductorTan !== undefined ? ` (TAN ${input.deductorTan})` : ""}`,
    );
    doc.text(`Deductee: ${input.affiliateLegalName}`);
    doc.text(`PAN: ${input.affiliatePan ?? "NOT ON FILE"}`);
    doc.text(`Financial year: 20${input.fyLabel}`);
    doc.text(`TDS section: ${input.tdsSection}`);
    doc.moveDown();
    doc.text(`Gross commission credited: ${formatRupees(input.grossMinor)}`);
    doc.text(`Tax deducted at source: ${formatRupees(input.tdsMinor)}`);
    doc.text(`Net amount paid: ${formatRupees(input.netMinor)}`);
    doc.end();
  });
}
