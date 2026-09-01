/**
 * עזרי עיצוב משותפים לגיליונות Excel (ExcelJS) - RTL, כותרות בלוק ממוזגות,
 * שורת כותרות עמודות צבעונית ושורות נתונים עם מסגרת. משמש את ייצוא בקשת
 * הלינה (dorms.routes.ts) ואת ייצוא רשימת המשתתפים (reports.routes.ts).
 */
import type ExcelJS from 'exceljs';

export const THIN_BORDER: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FF7B7B7B' } };
export const CELL_BORDER: Partial<ExcelJS.Borders> = {
  top: THIN_BORDER,
  bottom: THIN_BORDER,
  left: THIN_BORDER,
  right: THIN_BORDER,
};

/** כותרת מדור (בלוק) - שורה אחת ממוזגת על פני כל העמודות, עם רקע וטקסט לבן ובולט. */
export function writeSectionTitle(
  sheet: ExcelJS.Worksheet,
  row: number,
  text: string,
  fill: string,
  columnCount: number,
): void {
  sheet.mergeCells(row, 1, row, columnCount);
  const cell = sheet.getCell(row, 1);
  cell.value = text;
  cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  cell.alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 'rtl' };
  sheet.getRow(row).height = 20;
}

/** שורת כותרות עמודות לטבלה - רקע צבעוני, טקסט מודגש, מסגרת לכל תא. */
export function writeTableHeader(sheet: ExcelJS.Worksheet, row: number, headers: string[], fill: string): void {
  headers.forEach((text, index) => {
    const cell = sheet.getCell(row, index + 1);
    cell.value = text;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    cell.border = CELL_BORDER;
    cell.alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 'rtl' };
  });
}

/** שורת נתונים בטבלה - מסגרת לכל תא, יישור לימין (כברירת מחדל בגיליון RTL). */
export function writeDataRow(sheet: ExcelJS.Worksheet, row: number, values: Array<string | number>): void {
  values.forEach((value, index) => {
    const cell = sheet.getCell(row, index + 1);
    cell.value = value;
    cell.border = CELL_BORDER;
    cell.alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 'rtl' };
  });
}
