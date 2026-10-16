export function formatForSpeech(text: string): string {
  let output = String(text || "");
  output = output.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_match, hourText: string, minuteText: string) => {
    return clockTimeForSpeech(Number(hourText), Number(minuteText));
  });
  output = output.replace(
    /\b([1-9]|1[0-2])(?::([0-5]\d))?\s*(am|pm|a\.m\.|p\.m\.)\b/gi,
    (_match, hourText: string, minuteText: string | undefined, meridiemText: string) =>
      meridiemTimeForSpeech(Number(hourText), minuteText ? Number(minuteText) : 0, meridiemText),
  );
  output = output.replace(
    REPEATED_UNIT_RANGE_PATTERN,
    (_match, leftValueText: string, unitText: string, rightValueText: string) =>
      measurementRangeForSpeech(leftValueText, rightValueText, unitText),
  );
  output = output.replace(
    TRAILING_UNIT_RANGE_PATTERN,
    (_match, leftValueText: string, rightValueText: string, unitText: string) =>
      measurementRangeForSpeech(leftValueText, rightValueText, unitText),
  );
  output = output.replace(
    MEASUREMENT_PATTERN,
    (_match, valueText: string, unitText: string) => measurementForSpeech(valueText, unitText),
  );
  return output.replace(/\s+/g, " ").trim();
}

export function clockTimeForSpeech(hour24: number, minute: number): string {
  if (!Number.isInteger(hour24) || !Number.isInteger(minute) || hour24 < 0 || hour24 > 23 || minute < 0 || minute > 59) {
    return "";
  }
  if (hour24 === 0 && minute === 0) {
    return "midnight";
  }
  if (hour24 === 12 && minute === 0) {
    return "midday";
  }
  const hour12 = hour24 % 12 || 12;
  if (minute === 0) {
    return numberForSpeech(hour12);
  }
  if (minute < 10) {
    return `${numberForSpeech(hour12)} oh ${numberForSpeech(minute)}`;
  }
  return `${numberForSpeech(hour12)} ${numberForSpeech(minute)}`;
}

export function measurementForSpeech(valueText: string, unitText: string): string {
  const value = Number(valueText);
  if (!Number.isFinite(value)) {
    return `${valueText} ${unitText}`.trim();
  }
  const unit = unitText.replace(/^°/, "").toLowerCase();
  if (unit === "gbp") {
    return currencyForSpeech(value, "pound", "pounds", "pence");
  }
  if (unit === "usd") {
    return currencyForSpeech(value, "dollar", "dollars", "cents");
  }
  const number = numberForSpeech(value);
  switch (unit) {
    case "c":
    case "f":
      return `${number} degrees`;
    case "kwh":
      return `${number} kilowatt ${plural(value, "hour", "hours")}`;
    case "wh":
      return `${number} watt ${plural(value, "hour", "hours")}`;
    case "kw":
      return `${number} ${plural(value, "kilowatt", "kilowatts")}`;
    case "w":
      return `${number} ${plural(value, "watt", "watts")}`;
    case "%":
    case "percent":
      return `${number} percent`;
    case "km/h":
      return `${number} kilometre${Math.abs(value) === 1 ? "" : "s"} per hour`;
    case "mm":
      return `${number} millimetre${Math.abs(value) === 1 ? "" : "s"}`;
    case "s":
    case "sec":
    case "secs":
      return `${number} ${plural(value, "second", "seconds")}`;
    case "min":
    case "mins":
      return `${number} ${plural(value, "minute", "minutes")}`;
    default:
      return `${number} ${unitText}`.trim();
  }
}

export function measurementRangeForSpeech(leftValueText: string, rightValueText: string, unitText: string): string {
  const leftValue = Number(leftValueText);
  const rightValue = Number(rightValueText);
  if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
    return `${leftValueText} to ${rightValueText} ${unitText}`.trim();
  }
  const left = numberForSpeech(leftValue);
  const right = numberForSpeech(rightValue);
  const unit = unitText.replace(/^°/, "").toLowerCase();
  switch (unit) {
    case "c":
    case "f":
      return `${left} to ${right} degrees`;
    case "kwh":
      return `${left} to ${right} kilowatt hours`;
    case "wh":
      return `${left} to ${right} watt hours`;
    case "kw":
      return `${left} to ${right} kilowatts`;
    case "w":
      return `${left} to ${right} watts`;
    case "%":
    case "percent":
      return `${left} to ${right} percent`;
    case "km/h":
      return `${left} to ${right} kilometres per hour`;
    case "mm":
      return `${left} to ${right} millimetres`;
    case "s":
    case "sec":
    case "secs":
      return `${left} to ${right} seconds`;
    case "min":
    case "mins":
      return `${left} to ${right} minutes`;
    default:
      return `${left} to ${right} ${unitText}`.trim();
  }
}

export function numberForSpeech(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  if (value < 0) {
    return `minus ${numberForSpeech(Math.abs(value))}`;
  }
  if (!Number.isInteger(value)) {
    const [whole, fraction = ""] = String(value).split(".");
    const fractionWords = fraction.split("").map((digit) => SMALL[Number(digit)]).join(" ");
    return `${numberForSpeech(Number(whole))} point ${fractionWords}`.trim();
  }
  if (value < 20) {
    return SMALL[value] ?? String(value);
  }
  if (value < 100) {
    const ten = Math.floor(value / 10) * 10;
    const rest = value % 10;
    return rest ? `${TENS[ten]} ${SMALL[rest]}` : TENS[ten] ?? String(value);
  }
  if (value < 1000) {
    const hundreds = Math.floor(value / 100);
    const rest = value % 100;
    return rest ? `${SMALL[hundreds]} hundred and ${numberForSpeech(rest)}` : `${SMALL[hundreds]} hundred`;
  }
  if (value < 10000) {
    const thousands = Math.floor(value / 1000);
    const rest = value % 1000;
    return rest ? `${SMALL[thousands]} thousand ${numberForSpeech(rest)}` : `${SMALL[thousands]} thousand`;
  }
  return String(value);
}

function currencyForSpeech(value: number, singular: string, pluralText: string, centsLabel: string): string {
  const whole = Math.trunc(value);
  const cents = Math.round((value - whole) * 100);
  const unit = whole === 1 ? singular : pluralText;
  if (cents <= 0) {
    return `${numberForSpeech(whole)} ${unit}`;
  }
  if (whole <= 0) {
    return `${numberForSpeech(cents)} ${centsLabel}`;
  }
  return `${numberForSpeech(whole)} ${unit} ${numberForSpeech(cents)}`;
}

function meridiemTimeForSpeech(hour12: number, minute: number, meridiemText: string): string {
  const safeHour = hour12 >= 1 && hour12 <= 12 ? hour12 : 12;
  const base = minute === 0
    ? numberForSpeech(safeHour)
    : minute < 10
      ? `${numberForSpeech(safeHour)} oh ${numberForSpeech(minute)}`
      : `${numberForSpeech(safeHour)} ${numberForSpeech(minute)}`;
  const meridiem = /^a/i.test(meridiemText) ? "a m" : "p m";
  return `${base} ${meridiem}`.trim();
}

function plural(value: number, singular: string, pluralText: string): string {
  return Math.abs(value) === 1 ? singular : pluralText;
}

const SMALL = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
] as const;

const TENS: Record<number, string> = {
  20: "twenty",
  30: "thirty",
  40: "forty",
  50: "fifty",
  60: "sixty",
  70: "seventy",
  80: "eighty",
  90: "ninety",
};

const MEASUREMENT_UNIT_PATTERN = String.raw`(C|F|°C|°F|kWh|Wh|kW|W|%|percent|GBP|USD|s|sec|secs|min|mins|km\/h|mm)`;
const MEASUREMENT_SUFFIX_PATTERN = String.raw`(?=$|[\s,.;:!?\)])`;
const REPEATED_UNIT_RANGE_PATTERN = new RegExp(
  String.raw`\b(-?\d+(?:\.\d+)?)\s*${MEASUREMENT_UNIT_PATTERN}\s*(?:to|-)\s*(-?\d+(?:\.\d+)?)\s*\2${MEASUREMENT_SUFFIX_PATTERN}`,
  "gi",
);
const TRAILING_UNIT_RANGE_PATTERN = new RegExp(
  String.raw`\b(-?\d+(?:\.\d+)?)\s*(?:to|-)\s*(-?\d+(?:\.\d+)?)\s*${MEASUREMENT_UNIT_PATTERN}${MEASUREMENT_SUFFIX_PATTERN}`,
  "gi",
);
const MEASUREMENT_PATTERN = new RegExp(
  String.raw`\b(-?\d+(?:\.\d+)?)\s*(?:degrees?\s*)?${MEASUREMENT_UNIT_PATTERN}${MEASUREMENT_SUFFIX_PATTERN}`,
  "gi",
);
