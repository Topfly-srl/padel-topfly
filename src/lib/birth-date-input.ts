const italianDatePattern = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealDate(day: number, month: number, year: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function formatBirthDateInput(value: string) {
  const isoMatch = value.trim().match(isoDatePattern);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${day}/${month}/${year}`;
  }

  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

export function birthDateInputToIsoDate(value: string) {
  const italianMatch = value.trim().match(italianDatePattern);
  if (!italianMatch) return null;

  const [, dayText, monthText, yearText] = italianMatch;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);

  if (!isRealDate(day, month, year)) return null;

  return `${yearText}-${monthText}-${dayText}`;
}
