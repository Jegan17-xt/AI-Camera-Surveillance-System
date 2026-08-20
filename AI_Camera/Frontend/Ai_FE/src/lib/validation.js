// Shared input-validation helpers, used by both the Super Admin Portal
// (src/admin) and the User Portal (src/pages) so every form rejects bad
// input the same way — and mirrors Backend/api/validators.py rule for
// rule, so nothing that passes here ever gets surprised by the backend.
//
// Every validate* function returns an error message string, or "" (falsy)
// when the value is valid — call sites can do `error = validateX(...)`
// and treat a non-empty string as "invalid".

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE_PATTERN = /^\d{10}$/;
// Mirrors Backend/api/validators.py's WHATSAPP_NUMBER_PATTERN — looser
// than PHONE_PATTERN since a WhatsApp number always carries a country
// code (e.g. +919876543210), unlike the fixed 10-digit internal phone_number field.
export const WHATSAPP_NUMBER_PATTERN = /^\+?\d{8,15}$/;
export const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// Plain names/identifiers: letters, numbers, spaces, hyphen, underscore only.
export const NAME_CHARS_PATTERN = /^[A-Za-z0-9 _-]+$/;
// Address-like free text (Camera Location, Application Name) additionally
// allows the punctuation real addresses/titles actually need.
export const ADDRESS_CHARS_PATTERN = /^[A-Za-z0-9 _\-,.#]+$/;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;

export const PORT_MIN = 1;
export const PORT_MAX = 65535;
export const CHANNEL_MIN = 1;
export const CHANNEL_MAX = 256;

const MULTI_SPACE_PATTERN = / {2,}/g;

/** Trim outer whitespace and collapse internal runs of spaces to one. */
export function normalizeText(value) {
  return (value ?? "").toString().trim().replace(MULTI_SPACE_PATTERN, " ");
}

/**
 * Generic Name/Location/Application-Name style field: required (unless
 * required=false and blank), length bounds, and a restricted charset
 * (letters/numbers/spaces/hyphen/underscore, plus `, . #` when addressLike).
 */
export function validateTextField(
  value,
  label,
  { minLen = 1, maxLen = 100, required = true, addressLike = false } = {}
) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return required ? `${label} is required.` : "";
  }

  if (normalized.length < minLen) {
    return `${label} must be at least ${minLen} characters.`;
  }

  if (normalized.length > maxLen) {
    return `${label} must be ${maxLen} characters or fewer.`;
  }

  const pattern = addressLike ? ADDRESS_CHARS_PATTERN : NAME_CHARS_PATTERN;

  if (!pattern.test(normalized)) {
    return addressLike
      ? `${label} can only contain letters, numbers, spaces, hyphens, underscores, and , . #`
      : `${label} can only contain letters, numbers, spaces, hyphens, and underscores.`;
  }

  return "";
}

export function validateEmail(value, { required = true } = {}) {
  const trimmed = (value ?? "").trim();

  if (!trimmed) {
    return required ? "Please enter a valid email address." : "";
  }

  if (!EMAIL_PATTERN.test(trimmed)) {
    return "Please enter a valid email address.";
  }

  return "";
}

export function validatePhone(value, { required = true } = {}) {
  const trimmed = (value ?? "").trim();

  if (!trimmed) {
    return required ? "Phone number is required." : "";
  }

  if (!PHONE_PATTERN.test(trimmed)) {
    return "Phone number must contain exactly 10 digits.";
  }

  return "";
}

export function validateWhatsappNumber(value, { label = "WhatsApp Number", required = false } = {}) {
  const trimmed = (value ?? "").trim();

  if (!trimmed) {
    return required ? `${label} is required.` : "";
  }

  if (!WHATSAPP_NUMBER_PATTERN.test(trimmed)) {
    return `${label} must be a valid phone number with country code (e.g. +919876543210).`;
  }

  return "";
}

export function validateIPv4(value, label = "IP Address") {
  const trimmed = (value ?? "").trim();

  if (!trimmed) {
    return `${label} is required.`;
  }

  if (!IPV4_PATTERN.test(trimmed)) {
    return `${label} must be a valid IPv4 address.`;
  }

  return "";
}

export function validatePort(value) {
  const portInt = Number(value);

  if (value === "" || value === null || value === undefined || !Number.isInteger(portInt)) {
    return `Port number must be between ${PORT_MIN} and ${PORT_MAX}.`;
  }

  if (portInt < PORT_MIN || portInt > PORT_MAX) {
    return `Port number must be between ${PORT_MIN} and ${PORT_MAX}.`;
  }

  return "";
}

export function validateChannel(value) {
  const channelInt = Number(value);

  if (value === "" || value === null || value === undefined || !Number.isInteger(channelInt)) {
    return `Channel Number must be between ${CHANNEL_MIN} and ${CHANNEL_MAX}.`;
  }

  if (channelInt < CHANNEL_MIN || channelInt > CHANNEL_MAX) {
    return `Channel Number must be between ${CHANNEL_MIN} and ${CHANNEL_MAX}.`;
  }

  return "";
}

/**
 * strong=true enforces the full account-password policy (8-64 chars,
 * upper/lower/digit/special). strong=false is for device credentials
 * (camera/DVR passwords) — required + a sane max length only, since
 * real-world DVRs frequently use short/numeric-only passwords that a
 * strength policy would wrongly reject.
 */
export function validatePassword(value, { label = "Password", strong = true, maxLen = PASSWORD_MAX } = {}) {
  if (!value) {
    return `${label} is required.`;
  }

  if (!strong) {
    if (value.length > maxLen) {
      return `${label} must be ${maxLen} characters or fewer.`;
    }
    return "";
  }

  if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    return `${label} must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`;
  }

  if (!/[a-z]/.test(value)) {
    return `${label} must contain at least one lowercase letter.`;
  }

  if (!/[A-Z]/.test(value)) {
    return `${label} must contain at least one uppercase letter.`;
  }

  if (!/\d/.test(value)) {
    return `${label} must contain at least one number.`;
  }

  if (!/[^A-Za-z0-9]/.test(value)) {
    return `${label} must contain at least one special character.`;
  }

  return "";
}

export function validatePasswordsMatch(password, confirmPassword) {
  if (password !== confirmPassword) {
    return "Passwords do not match.";
  }
  return "";
}

export function validateNumberRange(value, label, { min, max, integer = true } = {}) {
  if (value === "" || value === null || value === undefined) {
    return `${label} must be a number.`;
  }

  const number = Number(value);

  if (Number.isNaN(number)) {
    return `${label} must be a number.`;
  }

  if (integer && !Number.isInteger(number)) {
    return `${label} must be a whole number.`;
  }

  if (min !== undefined && number < min) {
    return `${label} must be between ${min} and ${max}.`;
  }

  if (max !== undefined && number > max) {
    return `${label} must be between ${min} and ${max}.`;
  }

  return "";
}

export function validateChoice(value, label, allowedValues) {
  if (!allowedValues.includes(value)) {
    return `${label} must be one of: ${allowedValues.join(", ")}.`;
  }
  return "";
}

const ACCEPTED_EXTENSIONS_LABEL = (extensions) => extensions.map((e) => e.replace(".", "").toUpperCase()).join("/");

/**
 * Client-side pre-check before an upload even fires — extension +
 * size only (a real content/magic-byte check happens server-side,
 * since that's the only place it can't be bypassed). Returns an error
 * string or "".
 */
export function validateFileUpload(file, { allowedExtensions, maxBytes, label = "File" }) {
  if (!file) {
    return `${label} is required.`;
  }

  const ext = `.${file.name.split(".").pop()?.toLowerCase() || ""}`;

  if (!allowedExtensions.includes(ext)) {
    return `Only ${ACCEPTED_EXTENSIONS_LABEL(allowedExtensions)} files are supported.`;
  }

  if (file.size === 0) {
    return `${label} is empty.`;
  }

  if (file.size > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    return `${label} must be ${maxMb}MB or smaller.`;
  }

  return "";
}

function isRealCalendarDate(value, format) {
  // format is "dmy" (DD-MM-YYYY) or "ymd" (YYYY-MM-DD, native <input type="date"> value).
  const parts = value.split("-").map(Number);
  if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) return null;

  const [a, b, c] = parts;
  const [year, month, day] = format === "dmy" ? [c, b, a] : [a, b, c];

  const date = new Date(year, month - 1, day);
  const isReal = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;

  return isReal ? date : null;
}

/**
 * value is a native <input type="date"> value (YYYY-MM-DD). Rejects an
 * impossible date (e.g. 2026-02-30) and, unless allowFuture, any date
 * after today.
 */
export function validateDate(value, { label = "Date", required = true, allowFuture = true } = {}) {
  if (!value) {
    return required ? `${label} is required.` : "";
  }

  const date = isRealCalendarDate(value, "ymd");

  if (!date) {
    return `${label} is not a valid date.`;
  }

  if (!allowFuture) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (date > today) {
      return `${label} cannot be in the future.`;
    }
  }

  return "";
}

/** value is a native <input type="month"> value (YYYY-MM). */
export function validateMonth(value, { label = "Month", required = true, allowFuture = true } = {}) {
  if (!value) {
    return required ? `${label} is required.` : "";
  }

  if (!/^\d{4}-\d{2}$/.test(value)) {
    return `${label} is not a valid month.`;
  }

  const [year, month] = value.split("-").map(Number);

  if (month < 1 || month > 12) {
    return `${label} is not a valid month.`;
  }

  if (!allowFuture) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    if (year > currentYear || (year === currentYear && month > currentMonth)) {
      return `${label} cannot be in the future.`;
    }
  }

  return "";
}

/** Today's date as a YYYY-MM-DD string, for wiring into an <input type="date"> max attribute. */
export function todayDateValue() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/** Current month as a YYYY-MM string, for wiring into an <input type="month"> max attribute. */
export function currentMonthValue() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${mm}`;
}

/**
 * Combines a { field: error } map's values into a single boolean, e.g.
 * `isValid(errors)` for a submit-button `disabled` prop.
 */
export function hasNoErrors(errors) {
  return Object.values(errors).every((e) => !e);
}

// Tailwind classes to append to an existing input's className when it's
// invalid — appended, not replacing, so each form's existing base
// className/styling is untouched.
export const INVALID_INPUT_CLASS = "border-red-500/60 ring-1 ring-red-500/30";
