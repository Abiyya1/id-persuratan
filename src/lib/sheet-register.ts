import type { CSSProperties } from 'react';
import type { sheets_v4 } from 'googleapis';
import { REGISTER_MONTHS, REGISTER_FILLED_NUMBER_COLOR, parseRegisterHeadingRow, registerNumberFill } from './register-sheet';

export interface SheetRegisterCell {
  text: string;
  checked: boolean | null;
  style: CSSProperties;
  rowSpan?: number;
  colSpan?: number;
  covered?: boolean;
}
export interface SheetRegisterRow { sheetRow: number; height: number; cells: SheetRegisterCell[] }
export interface SheetRegisterDay { date: string; rows: SheetRegisterRow[] }
export interface SheetRegisterMonth {
  month: number;
  title: string;
  available: boolean;
  widths: number[];
  days: SheetRegisterDay[];
  fetchedAt: string;
}

const NUMBER_FILL_FORMULA = '=N("id-persuratan:number-fill:v1")=0';

/** Replace only our E-cell rules; leave imported conditional formatting untouched. */
export function buildRegisterFillRequests(sheetId: number, rows: readonly (readonly unknown[])[], rules: sheets_v4.Schema$ConditionalFormatRule[] = [], effectiveNumberText: readonly (sheets_v4.Schema$TextFormat | undefined)[] = []): sheets_v4.Schema$Request[] {
  const requests: sheets_v4.Schema$Request[] = [];
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (rule.booleanRule?.condition?.type === 'CUSTOM_FORMULA' && rule.booleanRule.condition.values?.length === 1 && rule.booleanRule.condition.values[0].userEnteredValue === NUMBER_FILL_FORMULA
      && rule.ranges?.length && rule.ranges.every((range) => range.sheetId === sheetId && range.startColumnIndex === 4 && range.endColumnIndex === 5)) {
      requests.push({ deleteConditionalFormatRule: { sheetId, index } });
    }
  }
  const groups = new Map<string, { fill: string; format: sheets_v4.Schema$CellFormat; ranges: sheets_v4.Schema$GridRange[] }>();
  rows.forEach((values, row) => {
    const fill = registerNumberFill(values);
    if (!fill) return;
    const nativeText = effectiveNumberText[row];
    const textFormat: sheets_v4.Schema$TextFormat = {};
    for (const property of ['bold', 'italic', 'strikethrough'] as const) {
      const value = nativeText?.[property];
      if (value !== undefined && value !== null) textFormat[property] = value;
    }
    if (nativeText?.foregroundColorStyle) textFormat.foregroundColorStyle = nativeText.foregroundColorStyle;
    else if (nativeText?.foregroundColor) textFormat.foregroundColor = nativeText.foregroundColor;
    const key = `${fill}:${JSON.stringify(textFormat)}`;
    let group = groups.get(key);
    if (!group) {
      const format: sheets_v4.Schema$CellFormat = { backgroundColor: { red: parseInt(fill.slice(1, 3), 16) / 255, green: parseInt(fill.slice(3, 5), 16) / 255, blue: parseInt(fill.slice(5, 7), 16) / 255 } };
      if (Object.keys(textFormat).length) format.textFormat = textFormat;
      group = { fill, format, ranges: [] };
      groups.set(key, group);
    }
    const previous = group.ranges.at(-1);
    if (previous?.endRowIndex === row) previous.endRowIndex = row + 1;
    else group.ranges.push({ sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 4, endColumnIndex: 5 });
  });
  for (const group of [...groups.values()].sort((a, b) => Number(b.fill === REGISTER_FILLED_NUMBER_COLOR) - Number(a.fill === REGISTER_FILLED_NUMBER_COLOR))) {
    requests.push({ addConditionalFormatRule: { index: 0, rule: { ranges: group.ranges, booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: NUMBER_FILL_FORMULA }] }, format: group.format } } } });
  }
  return requests;
}

export function parseSheetRegister(source: sheets_v4.Schema$Spreadsheet, month: number): SheetRegisterMonth {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('Bulan tidak valid.');
  const title = REGISTER_MONTHS[month - 1];
  const sheet = source.sheets?.find((item) => item.properties?.title === title);
  const result: SheetRegisterMonth = { month, title, available: !!sheet, widths: [], days: [], fetchedAt: new Date().toISOString() };
  if (!sheet) return result;
  const grid = sheet.data?.[0];
  if (!grid) return result;
  const startRow = grid.startRow ?? 0;
  const startColumn = grid.startColumn ?? 0;
  const defaults = source.properties?.defaultFormat ?? {};
  const themes = new Map((source.properties?.spreadsheetTheme?.themeColors ?? []).map((pair) => [pair.colorType, pair.color]));
  function color(style?: sheets_v4.Schema$ColorStyle | null, fallback?: sheets_v4.Schema$Color | null): string | undefined {
    const rgb = style?.rgbColor ?? (style?.themeColor ? themes.get(style.themeColor)?.rgbColor : undefined) ?? fallback;
    if (!rgb) return undefined;
    const hex = ['red', 'green', 'blue'].map((key) => Math.round(Math.max(0, Math.min(1, rgb[key as keyof typeof rgb] ?? 0)) * 255).toString(16).padStart(2, '0')).join('');
    return `#${hex}${rgb.alpha !== undefined && rgb.alpha !== null && rgb.alpha < 1 ? Math.round(rgb.alpha * 255).toString(16).padStart(2, '0') : ''}`;
  }
  function border(value?: sheets_v4.Schema$Border): string | undefined {
    if (!value?.style) return undefined;
    if (value.style === 'NONE') return 'none';
    const width = value.style === 'SOLID_THICK' || value.style === 'DOUBLE' ? 3 : value.style === 'SOLID_MEDIUM' ? 2 : 1;
    const line = value.style === 'DOTTED' ? 'dotted' : value.style === 'DASHED' ? 'dashed' : value.style === 'DOUBLE' ? 'double' : 'solid';
    return `${width}px ${line} ${color(value.colorStyle, value.color) ?? '#000000'}`;
  }
  function cellStyle(cell: sheets_v4.Schema$CellData): CSSProperties {
    const format = { ...defaults, ...(cell.effectiveFormat ?? cell.userEnteredFormat) };
    const text = { ...defaults.textFormat, ...format.textFormat };
    const style: CSSProperties = {
      backgroundColor: color(format.backgroundColorStyle, format.backgroundColor) ?? '#ffffff',
      color: color(text.foregroundColorStyle, text.foregroundColor) ?? '#000000',
      fontFamily: text.fontFamily ?? 'Arial',
      fontSize: `${text.fontSize ?? 10}pt`,
      lineHeight: 'normal',
      fontWeight: text.bold ? 'bold' : 'normal',
      fontStyle: text.italic ? 'italic' : 'normal',
      textDecoration: [text.underline && 'underline', text.strikethrough && 'line-through'].filter(Boolean).join(' ') || 'none',
      whiteSpace: format.wrapStrategy === 'WRAP' ? 'pre-wrap' : 'pre',
      overflowWrap: format.wrapStrategy === 'WRAP' ? 'anywhere' : undefined,
      overflow: 'hidden',
      border: sheet?.properties?.gridProperties?.hideGridlines ? 'none' : '1px solid #dadce0',
      paddingTop: format.padding?.top ?? 2,
      paddingRight: format.padding?.right ?? 3,
      paddingBottom: format.padding?.bottom ?? 2,
      paddingLeft: format.padding?.left ?? 3,
    };
    if (format.horizontalAlignment) style.textAlign = format.horizontalAlignment.toLowerCase() as CSSProperties['textAlign'];
    if (format.verticalAlignment) style.verticalAlign = format.verticalAlignment === 'MIDDLE' ? 'middle' : format.verticalAlignment.toLowerCase() as CSSProperties['verticalAlign'];
    if (format.borders) {
      style.borderTop = border(format.borders.top);
      style.borderRight = border(format.borders.right);
      style.borderBottom = border(format.borders.bottom);
      style.borderLeft = border(format.borders.left);
    }
    return style;
  }
  const rowsByIndex = new Map<number, SheetRegisterRow>();
  const registerMerges = (sheet.merges ?? []).filter((merge) => (merge.startColumnIndex ?? 0) >= 1 && (merge.endColumnIndex ?? 0) <= 13);
  const rowCount = registerMerges.reduce((count, merge) => Math.max(count, (merge.endRowIndex ?? 0) - startRow), grid.rowData?.length ?? 0);
  for (let column = 0; column < 12; column++) result.widths.push(grid.columnMetadata?.[column + 1 - startColumn]?.pixelSize ?? 100);
  let current: SheetRegisterDay | undefined;
  for (let index = 0; index < rowCount; index++) {
    const sourceRow = grid.rowData?.[index] ?? {};
    const cells = Array.from({ length: 12 }, (_, column): SheetRegisterCell => {
      const cell = sourceRow.values?.[column + 1 - startColumn] ?? {};
      const value = cell.effectiveValue ?? cell.userEnteredValue;
      const checked = typeof value?.boolValue === 'boolean' ? value.boolValue : null;
      return { text: cell.formattedValue ?? String(value?.stringValue ?? value?.numberValue ?? (checked === null ? '' : checked)), checked, style: cellStyle(cell) };
    });
    const heading = parseRegisterHeadingRow(cells.map((cell) => cell.text), month);
    if (heading) {
      if (result.days.some((day) => day.date === heading)) throw new Error('Tanggal register muncul lebih dari sekali.');
      current = { date: heading, rows: [] };
      result.days.push(current);
    }
    if (!current) continue;
    const fill = registerNumberFill(cells.map((cell) => cell.checked ?? cell.text));
    if (fill) cells[3].style.backgroundColor = fill;
    const row: SheetRegisterRow = { sheetRow: startRow + index + 1, height: grid.rowMetadata?.[index]?.pixelSize ?? 21, cells };
    current.rows.push(row);
    rowsByIndex.set(startRow + index, row);
  }
  for (const merge of registerMerges) {
    const left = merge.startColumnIndex ?? 0;
    const right = merge.endColumnIndex ?? 0;
    if (left < 1 || right > 13 || right <= left) continue;
    const top = merge.startRowIndex ?? 0;
    const bottom = merge.endRowIndex ?? 0;
    const anchor = rowsByIndex.get(top)?.cells[left - 1];
    if (!anchor) continue;
    anchor.rowSpan = bottom - top;
    anchor.colSpan = right - left;
    for (let row = top; row < bottom; row++) {
      for (let column = left; column < right; column++) {
        if (row === top && column === left) continue;
        const covered = rowsByIndex.get(row)?.cells[column - 1];
        if (covered) covered.covered = true;
      }
    }
  }
  for (const day of result.days) {
    while (day.rows.length > 3 && day.rows.at(-1)!.cells.every((cell) => cell.text === '' && cell.checked === null && !cell.covered)) {
      rowsByIndex.delete(day.rows.pop()!.sheetRow - 1);
    }
  }
  return result;
}
