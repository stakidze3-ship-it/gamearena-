/**
 * All money in GameArena is integer tetri (1 GEL = 100 tetri).
 * Never floats. Formatting uses U+2212 minus and the lari sign ₾.
 */

export const TETRI_PER_LARI = 100;

export function lariToTetri(lari: number): number {
  const t = Math.round(lari * TETRI_PER_LARI);
  if (!Number.isSafeInteger(t)) throw new Error(`Unsafe money value: ${lari}`);
  return t;
}

export function tetriToLari(tetri: number): number {
  return tetri / TETRI_PER_LARI;
}

/** "₾5.00" — unsigned absolute amount. */
export function formatTetri(tetri: number): string {
  const abs = Math.abs(tetri);
  const lari = Math.floor(abs / TETRI_PER_LARI);
  const rem = abs % TETRI_PER_LARI;
  return `₾${lari.toLocaleString("en-US")}.${rem.toString().padStart(2, "0")}`;
}

/** "+₾8.75" / "−₾5.00" / "₾0.00" — explicit sign for ledger display. */
export function formatSignedTetri(tetri: number): string {
  if (tetri > 0) return `+${formatTetri(tetri)}`;
  if (tetri < 0) return `−${formatTetri(tetri)}`;
  return formatTetri(0);
}

/** Compact form for stakes/buttons: "₾5" when whole, else "₾2.50". */
export function formatTetriCompact(tetri: number): string {
  const abs = Math.abs(tetri);
  if (abs % TETRI_PER_LARI === 0) return `₾${(abs / TETRI_PER_LARI).toLocaleString("en-US")}`;
  return formatTetri(tetri);
}
