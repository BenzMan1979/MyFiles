import { describe, expect, it } from 'vitest';
import { colIndex, colName, formatCell, formatDate, formatGeneral, formatNumber, isDateFormat, parseRange, parseRef, serialToDate } from '../src/viewer/xlsxFormat';

const none = new Map<number, string>();

describe('cell references', () => {
  it('converts column letters both ways', () => {
    expect([0, 25, 26, 27, 701, 702].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
    expect(['A', 'Z', 'AA', 'ZZ', 'AAA'].map(colIndex)).toEqual([0, 25, 26, 701, 702]);
  });
  it('parses cells and ranges', () => {
    expect(parseRef('AB12')).toEqual({ r: 11, c: 27 });
    expect(parseRef('12AB')).toBeNull();
    expect(parseRange('A1:C3')).toEqual({ r1: 0, c1: 0, r2: 2, c2: 2 });
    expect(parseRange('B2')).toEqual({ r1: 1, c1: 1, r2: 1, c2: 1 });
  });
});

describe('dates', () => {
  it('converts serial numbers, including Excel\'s 1900 leap-year quirk', () => {
    expect(serialToDate(1)).toMatchObject({ y: 1900, mo: 1, d: 1 });
    expect(serialToDate(59)).toMatchObject({ y: 1900, mo: 2, d: 28 });
    expect(serialToDate(61)).toMatchObject({ y: 1900, mo: 3, d: 1 });
    expect(serialToDate(45000)).toMatchObject({ y: 2023, mo: 3, d: 15 });
    expect(serialToDate(46325.5)).toMatchObject({ y: 2026, mo: 10, d: 30, h: 12, mi: 0 });
    expect(serialToDate(0, true)).toMatchObject({ y: 1904, mo: 1, d: 1 });
  });
  it('formats the usual patterns', () => {
    expect(formatDate(46325, 'yyyy-mm-dd')).toBe('2026-10-30');
    expect(formatDate(46325.75, 'yyyy/m/d h:mm')).toBe('2026/10/30 18:00');
    expect(formatDate(46325.75, 'yyyy"年"m"月"d"日"')).toBe('2026年10月30日');
    expect(formatDate(46325.75, 'h:mm AM/PM')).toBe('6:00 PM');
    expect(formatDate(46325.0104166667, '[h]:mm:ss')).toBe('0:15:00');
    expect(formatDate(46325, 'dddd, mmmm d, yyyy')).toBe('Friday, October 30, 2026');
    expect(formatDate(46325, 'd-mmm-yy')).toBe('30-Oct-26');
    expect(formatDate(46325.5, 'mm:ss')).toBe('00:00'); // minutes then seconds, not a month
  });
  it('tells dates from numbers', () => {
    expect(isDateFormat(14, 'yyyy-mm-dd')).toBe(true);
    expect(isDateFormat(176, 'yyyy"年"m"月"d"日"')).toBe(true);
    expect(isDateFormat(30, 'General')).toBe(true); // built-in locale date with no code in the file
    expect(isDateFormat(2, '0.00')).toBe(false);
    expect(isDateFormat(164, '#,##0.00_);(#,##0.00)')).toBe(false);
    expect(isDateFormat(165, '0.00"mm"')).toBe(false); // letters inside quotes are text
    expect(isDateFormat(49, '@')).toBe(false);
  });
});

describe('numbers', () => {
  it('shows General numbers like Excel', () => {
    expect(formatGeneral(0.1 + 0.2)).toBe('0.3');
    expect(formatGeneral(1234567)).toBe('1234567');
    expect(formatGeneral(-2.5)).toBe('-2.5');
    expect(formatGeneral(1.23456789012345678)).toBe('1.23456789012346');
  });
  it('formats decimals, thousands and percent', () => {
    expect(formatNumber(1234.5, '#,##0.00')).toBe('1,234.50');
    expect(formatNumber(1234.567, '0')).toBe('1235');
    expect(formatNumber(0.125, '0.0%')).toBe('12.5%');
    expect(formatNumber(0.5, '0%')).toBe('50%');
    expect(formatNumber(-1234.5, '#,##0.00')).toBe('-1,234.50');
    expect(formatNumber(2.5, '0.0#')).toBe('2.5');
    expect(formatNumber(2.125, '0.0#')).toBe('2.13');
  });
  it('keeps currency symbols and uses the negative section', () => {
    expect(formatNumber(1234.5, '"$"#,##0.00')).toBe('$1,234.50');
    expect(formatNumber(1234.5, '$#,##0.00')).toBe('$1,234.50');
    expect(formatNumber(-1234.5, '#,##0.00_);(#,##0.00)')).toBe('(1,234.50)');
    expect(formatNumber(1234.5, '#,##0.00_);(#,##0.00)')).toBe('1,234.50');
    expect(formatNumber(0.5, '0.00" 元"')).toBe('0.50 元');
  });
  it('handles scientific notation and text formats', () => {
    expect(formatNumber(12345.678, '0.00E+00')).toBe('1.23E+04');
    expect(formatNumber(12, '@')).toBe('12');
  });
  it('picks the format by style id, with the file\'s own codes taking precedence', () => {
    const custom = new Map([[164, '0.000'], [165, 'yyyy-mm-dd hh:mm']]);
    expect(formatCell(3.14159, 164, custom)).toBe('3.142');
    expect(formatCell(46325.5, 165, custom)).toBe('2026-10-30 12:00');
    expect(formatCell(0.25, 9, none)).toBe('25%');
    expect(formatCell(46325, 14, none)).toBe('2026-10-30');
    expect(formatCell(1234.5, 4, none)).toBe('1,234.50');
    expect(formatCell(7, 0, none)).toBe('7');
  });
});
