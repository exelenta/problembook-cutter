import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
export async function demoPdf() {
  const d = await PDFDocument.create(),
    f = await d.embedFont(StandardFonts.TimesRoman),
    bold = await d.embedFont(StandardFonts.TimesRomanBold);
  const text = (
    p: ReturnType<typeof d.addPage>,
    s: string,
    x: number,
    y: number,
    size = 11,
    b = false,
  ) =>
    p.drawText(s, {
      x,
      y: 780 - y,
      size,
      font: b ? bold : f,
      color: rgb(0.1, 0.15, 0.2),
    });
  const p = d.addPage([612, 780]);
  text(p, 'Exercises 1.1', 40, 50, 18, true);
  text(p, 'In Problems 1-4, verify each proposed solution.', 40, 82);
  text(p, '1.', 40, 118, 11, true);
  text(p, "y' + 2y = 0;     y = C exp(-2x)", 58, 118);
  text(p, '2.', 40, 180, 11, true);
  text(p, "y'' - y = 0;     y = A exp(x) + B exp(-x)", 58, 180);
  text(p, '3.', 40, 250, 11, true);
  text(p, 'Find a solution of the following system.', 58, 250);
  text(p, "x' = x + 3y", 58, 275);
  text(p, "y' = 5x + 3y", 58, 294);
  text(p, '4.', 40, 690, 11, true);
  text(p, 'Consider a function defined on two intervals.', 58, 690);
  text(p, 'The first interval is given below:', 58, 710);
  text(p, 'f(x) = x*x for x < 0.', 58, 730);
  text(p, 'On the second interval, f(x) = -x*x.', 330, 82);
  text(p, 'Check continuity and differentiability at zero.', 330, 102);
  text(p, 'In Problems 5-6, find the general solution.', 330, 152);
  text(p, '5.', 330, 190, 11, true);
  text(p, "y' = 3y", 348, 190);
  text(p, '6.', 460, 190, 11, true);
  text(p, "y' = -y", 478, 190);
  text(p, '7.', 330, 690, 11, true);
  text(p, 'A model for population growth is described', 348, 690);
  text(p, 'by a differential equation. The initial data', 348, 710);
  text(p, 'are listed on the following page.', 348, 730);
  const q = d.addPage([612, 780]);
  text(q, 'The initial population is 100.', 40, 82);
  text(q, 'Determine the population after ten years.', 40, 102);
  text(q, '8.', 40, 160, 11, true);
  text(q, "Solve y' = x with y(0) = 1.", 58, 160);
  text(q, 'Exercises 1.2', 40, 280, 18, true);
  text(q, 'This section is outside the requested range.', 40, 315);
  return d.save();
}
