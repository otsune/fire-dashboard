/** DSEG HH:MM is about 3.464em wide; leave a little glyph rounding room. */
export function clockDigitSize(
  width: number,
  height: number,
  reservedWidth: number,
): number {
  return Math.max(0, Math.min((width - reservedWidth) / 3.5, height / 1.08));
}
