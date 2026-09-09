/**
 * Shared normalization helpers (spec 2.1 / 3.1).
 * Plates and phones are stored as ASCII digits only; the client mirrors these rules.
 */

/** Map Arabic-Indic, Eastern-Arabic and full-width digits to ASCII digits. */
export const toAsciiDigits = (s) =>
  String(s ?? '')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\uFF10-\uFF19]/g, (d) => String(d.charCodeAt(0) - 0xff10));

/** Digits only ('' when empty). */
export const normalizePlate = (s) => toAsciiDigits(s).replace(/\D/g, '');

/** Israeli plates: 7 or 8 digits. */
export const isValidPlate = (s) => /^\d{7,8}$/.test(s);

/** Digits only, international prefix 972 folded back to a leading 0 ('' when empty). */
export const normalizePhone = (s) => {
  let d = toAsciiDigits(s).replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  return d;
};

export const isValidPhone = (s) => /^0\d{8,9}$/.test(s);

/** Case-insensitive, whitespace-collapsed key used for catalog uniqueness. */
export const titleKeyOf = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Money: ILS rounded to 2 decimals. */
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Display form of a plate: 7 digits -> 12-345-67, 8 digits -> 123-45-678, anything else unchanged. */
export const formatPlate = (plate) => {
  const d = normalizePlate(plate);
  if (d.length === 7) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  if (d.length === 8) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  return d;
};
