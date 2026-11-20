import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';

export const OFFER_LETTER_DISCLAIMER = 'COMMEMORATIVE GAME OFFER LETTER — NOT AN EMPLOYMENT OFFER';

export interface OfferLetterData {
  participant: string;
  team: string;
  role: string;
  vehicle: string;
  achievement: string;
  finalScore: number;
  arrivalStatus: string;
  eventName: string;
  date: string;
}

/** Characters the standard PDF font can't encode are replaced (documented limitation: non-Latin names). */
function safe(font: PDFFont, text: string) {
  let out = '';
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

/**
 * A commemorative, clearly-fictional game letter. No company logo or letterhead: only approved branding may be
 * used and none has been supplied, so the destination is named in plain text only.
 */
export async function buildOfferLetterPdf(d: OfferLetterData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`CODE REDLINE commemorative letter — ${d.participant}`);
  pdf.setSubject(OFFER_LETTER_DISCLAIMER);
  pdf.setCreator('CODE REDLINE: ROAD TO HEXAWARE');
  const page = pdf.addPage([595.28, 841.89]); // A4
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const red = rgb(0.85, 0.07, 0.17);
  const ink = rgb(0.1, 0.1, 0.12);
  const W = page.getWidth();
  let y = 800;
  const text = (t: string, opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number } = {}) => {
    const font = opts.font ?? reg;
    page.drawText(safe(font, t), { x: opts.x ?? 56, y, size: opts.size ?? 11, font, color: opts.color ?? ink });
  };
  // Disclaimer banner (top)
  page.drawRectangle({ x: 40, y: y - 14, width: W - 80, height: 30, color: red });
  text(OFFER_LETTER_DISCLAIMER, { size: 12.5, font: bold, color: rgb(1, 1, 1), x: 52 });
  y -= 60;
  text('CODE REDLINE: ROAD TO HEXAWARE', { size: 20, font: bold });
  y -= 22;
  text('Race. Decode. Survive. Arrive.', { size: 11, color: rgb(0.4, 0.4, 0.45) });
  y -= 40;
  text(d.date);
  y -= 30;
  text(`Dear ${d.participant},`, { size: 12 });
  y -= 26;
  for (const line of [
    `Congratulations on completing ${d.eventName}. On behalf of the race control team, we are delighted`,
    'to recognise your part in the squad that raced, decoded, survived and arrived at the Hexaware gate',
    'in Siruseri. This letter commemorates your game result and has no other meaning.',
  ]) {
    text(line);
    y -= 16;
  }
  y -= 18;
  const fields: [string, string][] = [
    ['Participant', d.participant],
    ['Team', d.team],
    ['Role', d.role],
    ['Vehicle', d.vehicle],
    ['Achievement', d.achievement],
    ['Final score', `${d.finalScore} / 1000`],
    ['Campus arrival status', d.arrivalStatus],
  ];
  for (const [k, v] of fields) {
    text(`${k}:`, { font: bold, size: 12 });
    text(v, { size: 12, x: 210 });
    y -= 22;
  }
  y -= 20;
  text('With congratulations,', { size: 11 });
  y -= 16;
  text('CODE REDLINE Race Control', { size: 11, font: bold });
  // Disclaimer (bottom)
  y = 70;
  page.drawLine({ start: { x: 40, y: 90 }, end: { x: W - 40, y: 90 }, thickness: 1, color: red });
  text(OFFER_LETTER_DISCLAIMER, { size: 11, font: bold, color: red });
  y -= 16;
  text('This is a game keepsake. It is not an offer, contract or promise of employment from any company.', { size: 9, color: rgb(0.4, 0.4, 0.45) });
  return pdf.save({ useObjectStreams: false });
}
