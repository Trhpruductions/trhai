import type { SlideContent } from "./deckData.js";
import { plainText } from "./markdown.js";

// How much fits on a slide. Text that runs off the bottom of a slide is the commonest way
// for a made deck to look made by a machine, so the PowerPoint file, the PDF and the
// splitting of a slide that has too much on it (deckData.ts) all measure the same way:
// how many letters of Calibri go on a line at a size, and how many points tall that
// makes what is there. Everything here is in points (72 to the inch) unless it says.

export type Table = Extract<SlideContent, { kind: "table" }>;

/** The room a slide's body has, in points: the box is 4.9 inches tall, less its margins and a little to be safe. */
export const bodyRoom = 330;

/** Points across the body, less the box's margins. */
const across = 813;

/** The average width of a Calibri letter in ems. Measured on printed slides it is 0.40; a little more keeps a slide on the side of having room. */
const letterWidth = 0.43;
const monoWidth = 0.55;
const leading = 1.22;

/** How many letters go on a line at a size, with some of the width taken by an indent. */
const lettersAcross = (size: number, indent: number, width = letterWidth) => Math.max(8, Math.floor((across - indent) / (size * width)));
const linesFor = (text: string, size: number, indent: number) => Math.max(1, Math.ceil(text.length / lettersAcross(size, indent)));

/** The sizes body text is set at, largest first. */
export const bodySizes = [28, 24, 20] as const;

// ---------------------------------------------------------------- titles

/** A title's size in points, from how long it is: the longer, the smaller, so that it stays in its box. */
export function titleSize(text: string, onTitleSlide: boolean): number {
  const steps = onTitleSlide ? [[24, 54], [40, 44], [70, 36], [110, 30]] : [[100, 36], [150, 32], [200, 28]];
  for (const [most, size] of steps) if (text.length <= most) return size;
  return 24;
}

/** The size of a title slide's subtitle, in points, from how much of it there is. */
export const subtitleSize = (subtitle: string): number => (subtitle.length <= 120 ? 24 : subtitle.length <= 200 ? 20 : 16);

// ---------------------------------------------------------------- tables

/** How wide each of a table's columns is, as a share of the whole: from the longest thing in it, kept between 6 and 40 letters' worth. */
export function columnWeights(table: Table): number[] {
  return table.header.map((header, column) => Math.min(40, Math.max(6, Math.max(plainText(header).length, ...table.rows.map((row) => plainText(row[column] ?? []).length)))));
}

/** The size a table's text is set at: smaller when there are many rows or columns. */
export const tableFont = (table: Table): number => (table.rows.length > 6 || table.header.length > 4 ? 14 : 16);

/** How tall each of a table's rows is, header first: at least 33 points, more where a cell's words wrap. */
export function rowHeights(table: Table): number[] {
  const weights = columnWeights(table);
  const sum = weights.reduce((a, b) => a + b, 0);
  const size = tableFont(table);
  return [table.header, ...table.rows].map((row) => {
    const lines = Math.max(1, ...row.map((cell, column) => {
      const room = Math.max(4, Math.floor(((weights[column] / sum) * 828 - 14.4) / (size * letterWidth)));
      return Math.ceil(plainText(cell).length / room);
    }));
    return Math.max(33, lines * size * leading + 8);
  });
}

// ---------------------------------------------------------------- bodies

/** How tall some content is at a body size, in points, with the space before each paragraph. */
export function heightOf(content: SlideContent[], size: number): number {
  let points = 0;
  for (const item of content) {
    switch (item.kind) {
      case "bullets":
        for (const bullet of item.items) {
          const at = size - bullet.level * 2;
          const indent = bullet.task ? bullet.level * 31.5 : bullet.number !== null ? 36 + bullet.level * 31.5 : 27 + bullet.level * 36;
          points += linesFor(plainText(bullet.inlines), at, indent) * at * leading + (bullet.level === 0 ? 10 : 5);
        }
        break;
      case "text": points += linesFor(plainText(item.inlines), size, 0) * size * leading + 6; break;
      case "quote": points += linesFor(plainText(item.inlines), size, 27) * size * leading + 6; break;
      case "code": {
        const at = Math.max(14, size - 6);
        points += item.lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / lettersAcross(at, 0, monoWidth))), 0) * at * leading + 6;
        break;
      }
      case "table": points += rowHeights(item).reduce((a, b) => a + b, 0) + 12; break;
    }
  }
  return points;
}

/** The size to set a slide's body text at: the largest of the sizes that leaves it all in the box. */
export const bodySize = (content: SlideContent[]): number => bodySizes.find((size) => heightOf(content, size) <= bodyRoom) ?? bodySizes[bodySizes.length - 1];

/** Whether content fits on one slide, at the smallest size body text is set at. */
export const fits = (content: SlideContent[]): boolean => heightOf(content, bodySizes[bodySizes.length - 1]) <= bodyRoom;
