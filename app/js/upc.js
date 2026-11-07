// UPC/EAN helpers shared by the browser app and the build scripts.

// GS1 check digit for a digit string without its check digit.
export function checkDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return String((10 - (sum % 10)) % 10);
}

export function isValidGtin(code) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  return checkDigit(code.slice(0, -1)) === code.slice(-1);
}

// Pad a valid UPC-A / EAN-13 / GTIN-14 to 14 digits so different spellings compare equal.
export function toGtin14(code) {
  return code.padStart(14, '0');
}

// Expand an 8-digit UPC-E (number system 0 or 1) to its 12-digit UPC-A.
export function expandUpcE(code) {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0], d = code.slice(1, 7), check = code[7];
  const last = d[5];
  let body;
  if (last <= '2') body = d.slice(0, 2) + last + '0000' + d.slice(2, 5);
  else if (last === '3') body = d.slice(0, 3) + '00000' + d.slice(3, 5);
  else if (last === '4') body = d.slice(0, 4) + '00000' + d[4];
  else body = d.slice(0, 5) + '0000' + last;
  const upca = ns + body + check;
  return isValidGtin(upca) ? upca : null;
}

// Normalise a code read by a scanner or typed by a person. Returns a GTIN-14 or null.
// format is the scanner's symbology name when known ('upc_e', 'UPC-E', 'ean_8', ...).
export function normaliseScanned(raw, format = '') {
  const digits = String(raw || '').replace(/\D/g, '');
  const f = String(format).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (digits.length === 8 && f !== 'ean8') {
    const upca = expandUpcE(digits);
    if (upca) return toGtin14(upca);
  }
  if (isValidGtin(digits)) return toGtin14(digits);
  // An 11-digit entry is a UPC-A without its check digit.
  if (digits.length === 11) return toGtin14(digits + checkDigit(digits));
  return null;
}

// Pull UPCs out of free recall text such as "UPC 0 41220 12345 6" or "UPC: 850013256022, 850013256039".
// Returns [{ gtin14, derived }] where derived means the check digit was added by us.
export function extractUpcs(text) {
  const found = new Map();
  if (!text) return [];
  const re = /\b(?:UPC|U\.P\.C\.|GTIN|EAN)s?\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const windowText = text.slice(m.index + m[0].length, m.index + m[0].length + 600);
    // Stop at the next field-like label so lot codes and dates are not read as UPCs.
    const stop = windowText.search(/\b(?:lot|best\s*by|exp(?:iration)?|sell\s*by|use\s*by|item|sku|code\s*date)\b/i);
    const scope = stop > 0 ? windowText.slice(0, stop) : windowText;
    const groups = scope.match(/\d[\d \-]{6,22}\d/g) || [];
    for (const g of groups) {
      const digits = g.replace(/\D/g, '');
      if (isValidGtin(digits) && digits.length >= 12) {
        found.set(toGtin14(digits), false);
      } else if (digits.length === 11) {
        const full = digits + checkDigit(digits);
        if (!found.has(toGtin14(full))) found.set(toGtin14(full), true);
      }
    }
  }
  return [...found].map(([gtin14, derived]) => ({ gtin14, derived }));
}
