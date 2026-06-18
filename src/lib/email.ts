const invisibleEmailChars = /[\u200B-\u200D\uFEFF]/g;
const nonBreakingSpaces = /\u00A0/g;

export function normalizeEmailInput(email: string) {
  return email.replace(invisibleEmailChars, "").replace(nonBreakingSpaces, " ").trim().toLowerCase();
}

export function isValidEmail(value: string) {
  const email = normalizeEmailInput(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizeAllowedDomain(domain: string) {
  return domain.replace(invisibleEmailChars, "").replace(nonBreakingSpaces, " ").trim().toLowerCase().replace(/^@+/, "");
}

export function isEmailAtDomain(email: string, domain: string) {
  if (!isValidEmail(email)) return false;

  const normalizedEmail = normalizeEmailInput(email);
  const normalizedDomain = normalizeAllowedDomain(domain);
  const atIndex = normalizedEmail.lastIndexOf("@");

  return atIndex >= 0 && normalizedEmail.slice(atIndex + 1) === normalizedDomain;
}

export function isExternalEmailForDomain(email: string, domain: string) {
  return isValidEmail(email) && !isEmailAtDomain(email, domain);
}
