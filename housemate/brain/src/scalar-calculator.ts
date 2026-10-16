import { POLITENESS_PATTERN } from "./lexicon.js";
import { normalizeWords } from "./speech-normalizer.js";
import { capitalize } from "./text-format.js";
import { householdRegex } from "./household.js";

export interface ScalarCalculationOk {
  readonly status: "ok";
  readonly expression: string;
  readonly value: number | null;
  readonly text: string;
}

export interface ScalarCalculationDeclined {
  readonly status: "declined";
  readonly reason: string;
}

export type ScalarCalculationResult = ScalarCalculationOk | ScalarCalculationDeclined;

export interface ScalarCalculationFollowUpOk {
  readonly status: "ok";
  readonly value: number;
  readonly text: string;
}

const UNSUPPORTED_MATH_REASON = "I can do arithmetic and unit conversions, but not symbolic maths yet.";

export function resolveScalarCalculation(input: string): ScalarCalculationResult | null {
  const body = unwrapCalculationPrompt(input);
  if (!body) {
    return null;
  }
  const conversion = resolveUnitConversion(body);
  if (conversion) {
    return conversion;
  }
  const rewritten = rewriteImperativeShape(body);
  const tokens = normalizeCalculationTokens(tokenizeCalculation(rewritten));
  if (tokens.length === 0 || !tokens.some(isMathSignalToken)) {
    return null;
  }
  try {
    const parser = new ScalarExpressionParser(tokens);
    const expression = parser.parseExpression();
    if (!expression || !parser.atEnd() || !parser.usedMath) {
      return null;
    }
    if (!Number.isFinite(expression.value)) {
      return { status: "declined", reason: "That blows out my local calculator." };
    }
    return {
      status: "ok",
      expression: expression.text,
      value: normalizeOutputValue(expression.value),
      text: `${expression.text} is ${formatScalarCalculationValue(expression.value)}.`,
    };
  } catch (error: unknown) {
    if (error instanceof ScalarCalculationError) {
      return { status: "declined", reason: error.message };
    }
    throw error;
  }
}

export function resolveUnsupportedMathPrompt(input: string): string | null {
  return looksLikeUnsupportedMathRequest(input) ? UNSUPPORTED_MATH_REASON : null;
}

/**
 * Own requests for a symbolic result, not questions about the concept itself.
 * An unsupported maths noun is not enough to prove calculation intent.
 */
export function looksLikeUnsupportedMathRequest(input: string): boolean {
  const request = normalizeUnsupportedMathRequest(input);
  if (!request) {
    return false;
  }

  if (/^(?:differentiate|integrate)\b\s+.+$/.test(request)) {
    return true;
  }
  if (/^derive\b\s+.+$/.test(request)) {
    return hasSymbolicVariable(request) || /\b(?:equation|expression|formula|function)\b/.test(request);
  }
  if (/^solve\b\s+.+$/.test(request)) {
    return hasSymbolicVariable(request) || hasEquationSignal(request);
  }
  if (/^(?:factori[sz]e|expand|simplify)\b\s+.+$/.test(request)) {
    return hasSymbolicVariable(request) || /\b(?:equation|expression|polynomial)\b/.test(request);
  }
  if (/^(?:multiply|add|subtract|invert|transpose)\b.*\b(?:matrices|matrix|vectors?|determinants?)\b/.test(request)) {
    return true;
  }

  const command = "(?:calculate|compute|evaluate|find|determine|work out|take|give me)";
  if (new RegExp(`^(?:(?:${command}|what (?:is|are)) (?:the )?)?(?:matrix|matrices)\\s+(?:inverse|transpose|determinant)$`).test(request)) {
    return true;
  }

  const result = "(?:dot products?|cross products?|derivatives?|integrals?|antiderivatives?|limits?|determinants?|eigenvalues?|inverses?|sine|sin|cosine|cos|tangent|tan|logarithms?|log|ln)";
  const relation = "(?:of|for|at|as|from|when)";
  const commandResult = new RegExp(
    `^${command} (?:the )?(${result})(?:\\s+(?:(${relation})\\s+)?(.+)|$)`,
  );
  const questionResult = new RegExp(
    `^what (?:is|are) (?:the )?(${result})(?:\\s+(?:(${relation})\\s+)?(.+)|$)`,
  );
  const bareResult = new RegExp(
    `^(?:the )?(${result})(?:\\s+(?:(${relation})\\s+)?(.+))$`,
  );
  const resultRequest = commandResult.exec(request) ?? questionResult.exec(request) ?? bareResult.exec(request);
  if (resultRequest?.[1]) {
    return symbolicResultRequestHasMathEvidence(
      resultRequest[1],
      resultRequest[2] ?? null,
      resultRequest[3] ?? "",
    );
  }

  const requestedVariable = /^(?:find|determine|what is)\s+(?:x|y|z|n|t)\b/.test(request);
  return requestedVariable && hasEquationSignal(request);
}

function normalizeUnsupportedMathRequest(input: string): string {
  let text = input
    .toLowerCase()
    .replaceAll(/[’']/g, "")
    .replaceAll(/=/g, " equals ")
    .replaceAll(/[^a-z0-9.+\-*/^\s]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of [
      householdRegex(String.raw`^(?:uh|um|hey {ASSISTANT}|{ASSISTANT}|mate|please|right|okay|ok)\s+`),
      /^(?:can|could|would|will) you\s+/,
      /^(?:go ahead(?: and)?|go on(?: and)?)\s+/,
      /^just\s+/,
    ]) {
      const next = text.replace(prefix, "").trim();
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
  }
  text = text
    .replace(/^help me(?: to)?\s+(?=(?:differentiate|integrate|derive|solve|factori[sz]e|expand|simplify|multiply|add|subtract|invert|transpose|calculate|compute|evaluate|find|determine)\b)/, "")
    .replace(/^i (?:need|want|would like)(?: you to)?\s+(?=(?:differentiate|integrate|derive|solve|factori[sz]e|expand|simplify|multiply|add|subtract|invert|transpose|calculate|compute|evaluate|find|determine)\b)/, "")
    .replace(/^(?:do|i (?:need|want|would like))\s+(?:the\s+)?(?=(?:derivatives?|integrals?|antiderivatives?|limits?|determinants?|eigenvalues?|inverses?|sine|sin|cosine|cos|tangent|tan|logarithms?|log|ln)\b)/, "calculate ");
  return text
    .replace(new RegExp(String.raw`\s+${POLITENESS_PATTERN}(?:\s+${POLITENESS_PATTERN})*$`), "")
    .trim();
}

function symbolicResultRequestHasMathEvidence(
  result: string,
  relation: string | null,
  argument: string,
): boolean {
  if (!argument.trim()) return false;
  const normalizedResult = result === "cos" ? result : result.replace(/s$/, "");
  const symbolicArgument = hasSymbolicVariable(argument)
    || hasEquationSignal(argument)
    || /\b(?:equation|expression|formula|function|polynomial)\b/.test(argument);
  if (/^(?:derivative|integral|antiderivative)$/.test(normalizedResult)) {
    return (relation === null || relation === "of" || relation === "for") && symbolicArgument;
  }
  if (normalizedResult === "limit") {
    return ((relation === null || relation === "of" || relation === "for") && symbolicArgument)
      || (relation === "as" && /\bapproach(?:es|ing)?\b/.test(argument));
  }
  if (/^(?:determinant|eigenvalue|inverse)$/.test(normalizedResult)) {
    return (relation === null || relation === "of" || relation === "for")
      && (/\b(?:matrix|matrices)\b/.test(argument) || symbolicArgument);
  }
  if (/^(?:dot product|cross product)$/.test(normalizedResult)) {
    return (relation === null || relation === "of" || relation === "for")
      && /\b(?:vectors?|matrices|matrix)\b/.test(argument);
  }
  if (/^(?:sine|sin|cosine|cos|tangent|tan|logarithm|log|ln)$/.test(normalizedResult)) {
    const basedLog = /^(?:logarithm|log|ln)$/.test(normalizedResult)
      ? /^base\s+(.+?)\s+of\s+(.+)$/.exec(argument)
      : null;
    if (basedLog?.[1] && basedLog[2]) {
      return relation === null
        && hasWholeMathExpressionArgument(basedLog[1])
        && hasWholeMathExpressionArgument(basedLog[2]);
    }
    return (relation === null || relation === "of") && hasWholeMathExpressionArgument(argument);
  }
  return false;
}

function hasWholeMathExpressionArgument(argument: string): boolean {
  const normalized = argument
    .replace(/^(?:the )?(?:number|value)\s+/, "")
    .replace(/\s+(?:degrees?|radians?)$/, "")
    .trim();
  const tokens = tokenizeCalculation(normalized);
  if (tokens.length === 0) return false;
  const wordNumber = consumeWordNumber(tokens, 0);
  if (wordNumber?.nextIndex === tokens.length) return true;
  if (tokens.length === 1 && (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(tokens[0] ?? "")
    || /^(?:pi|tau|infinity|e|x|y|z|n|t)$/.test(tokens[0] ?? ""))) {
    return true;
  }
  const mathWords = new Set([
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
    "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand",
    "million", "billion", "and", "point", "negative", "minus", "plus", "times", "multiplied", "by", "divided",
    "over", "to", "the", "power", "squared", "cubed", "square", "cube", "root", "of", "pi", "tau", "infinity",
    "e", "x", "y", "z", "n", "t", "f", "g", "h",
  ]);
  const onlyMathTokens = tokens.every((token) => /^(?:\d+(?:\.\d+)?|\.\d+|[%()+\-*/^])$/.test(token) || mathWords.has(token));
  const hasOperand = tokens.some((token) => /^(?:\d+(?:\.\d+)?|\.\d+|pi|tau|infinity|e|x|y|z|n|t)$/.test(token)
    || SMALL_NUMBER_WORDS[token] !== undefined
    || TENS_NUMBER_WORDS[token] !== undefined);
  return onlyMathTokens && hasOperand;
}

function hasEquationSignal(text: string): boolean {
  return /\b(?:equation|equals?|equal to)\b/.test(text) || /[+\-*/^]/.test(text);
}

export function resolveScalarCalculationFollowUp(previousValue: number, input: string): ScalarCalculationFollowUpOk | null {
  if (!Number.isFinite(previousValue)) {
    return null;
  }
  const normalized = normalizeWords(input).replace(/^(?:(?:and )?then|now)\s+/, "");
  const roundedPlaces = /^round (?:that|it)(?: to (\d+))?(?: decimal places?)?$/.exec(normalized)
    ?? /^now round (?:that|it)(?: to (\d+))?(?: decimal places?)?$/.exec(normalized)
    ?? /^round (?:that|it) off(?: to (\d+))?(?: decimal places?)?$/.exec(normalized);
  if (roundedPlaces) {
    const places = roundedPlaces[1] ? Math.min(6, Number(roundedPlaces[1])) : 0;
    const value = roundToPlaces(previousValue, places);
    return {
      status: "ok",
      value,
      text: places === 0 ? `About ${formatScalarCalculationValue(value)}.` : `Rounded to ${places} decimal place${places === 1 ? "" : "s"}, that's ${formatScalarCalculationValue(value)}.`,
    };
  }
  if (/^round that to something i d actually say out loud$/.test(normalized)) {
    const value = Math.round(previousValue);
    return { status: "ok", value, text: `About ${formatScalarCalculationValue(value)}.` };
  }
  if (/^(?:what if i )?doubled (?:that|it)$/.test(normalized) || /^(?:double|double up) (?:that|it)$/.test(normalized)) {
    const value = normalizeOutputValue(previousValue * 2);
    return { status: "ok", value, text: `That would be ${formatScalarCalculationValue(value)}.` };
  }
  if (/^(?:halve|half) (?:that|it|that result|the result)$/.test(normalized) || /^what if i halved (?:that|it|the result)$/.test(normalized)) {
    const value = normalizeOutputValue(previousValue / 2);
    return { status: "ok", value, text: `That would be ${formatScalarCalculationValue(value)}.` };
  }
  if (/^square (?:that|it)$/.test(normalized) || /^what if i squared (?:that|it)$/.test(normalized)) {
    const value = normalizeOutputValue(previousValue ** 2);
    return { status: "ok", value, text: `That would be ${formatScalarCalculationValue(value)}.` };
  }
  if (/^cube (?:that|it)$/.test(normalized) || /^what if i cubed (?:that|it)$/.test(normalized)) {
    const value = normalizeOutputValue(previousValue ** 3);
    return { status: "ok", value, text: `That would be ${formatScalarCalculationValue(value)}.` };
  }
  if (/^give me just the answer$/.test(normalized)) {
    return { status: "ok", value: previousValue, text: formatScalarCalculationValue(previousValue) };
  }
  const relativeExpression = relativeCalculationExpression(previousValue, normalized);
  if (relativeExpression) {
    const calculated = resolveScalarCalculation(relativeExpression);
    if (calculated?.status === "ok" && calculated.value !== null) {
      return {
        status: "ok",
        value: calculated.value,
        text: `That would be ${formatScalarCalculationValue(calculated.value)}.`,
      };
    }
  }
  return null;
}

function relativeCalculationExpression(previousValue: number, normalized: string): string | null {
  const prior = formatScalarCalculationValue(previousValue);
  const add = /^(?:now )?add (.+?)(?: to (?:that|it|the result))?$/.exec(normalized);
  if (add?.[1]) {
    return `${prior} plus ${add[1]}`;
  }
  const subtract = /^(?:now )?subtract (.+?)(?: from (?:that|it|the result))?$/.exec(normalized);
  if (subtract?.[1]) {
    return `${prior} minus ${subtract[1]}`;
  }
  const multiply = /^(?:now )?(?:multiply (?:that|it|the result) by|(?:that|it|the result )?times) (.+)$/.exec(normalized);
  if (multiply?.[1]) {
    return `${prior} times ${multiply[1]}`;
  }
  const divide = /^(?:now )?divide (?:that|it|the result) by (.+)$/.exec(normalized);
  if (divide?.[1]) {
    return `${prior} divided by ${divide[1]}`;
  }
  return null;
}

export function looksLikeScalarCalculationFollowUp(input: string): boolean {
  return resolveScalarCalculationFollowUp(1, input) !== null;
}

export function formatScalarCalculationValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "not a number";
  }
  const normalized = normalizeOutputValue(value);
  if (Number.isInteger(normalized)) {
    return String(normalized);
  }
  return normalized.toFixed(6).replace(/\.?0+$/, "");
}

interface ParsedScalarExpression {
  readonly value: number;
  readonly text: string;
  readonly precedence: number;
}

class ScalarExpressionParser {
  private index = 0;

  usedMath = false;

  constructor(private readonly tokens: readonly string[]) {}

  atEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  parseExpression(): ParsedScalarExpression | null {
    return this.parseAddition();
  }

  private parseAddition(): ParsedScalarExpression | null {
    let left = this.parseMultiplication();
    if (!left) {
      return null;
    }
    while (true) {
      const operator = this.peek();
      if (operator !== "+" && operator !== "-") {
        return left;
      }
      this.usedMath = true;
      this.index += 1;
      const right = this.parseMultiplication();
      if (!right) {
        return null;
      }
      left = {
        value: operator === "+" ? left.value + right.value : left.value - right.value,
        text: `${wrapBinaryOperand(left, 1)} ${operator === "+" ? "plus" : "minus"} ${wrapBinaryOperand(right, 1, true)}`,
        precedence: 1,
      };
    }
  }

  private parseMultiplication(): ParsedScalarExpression | null {
    let left = this.parsePower();
    if (!left) {
      return null;
    }
    while (true) {
      const operator = this.peek();
      if (operator !== "*" && operator !== "/" && operator !== "of") {
        return left;
      }
      this.usedMath = true;
      this.index += 1;
      const right = this.parsePower();
      if (!right) {
        return null;
      }
      if (operator === "/" && right.value === 0) {
        throw new ScalarCalculationError("I can't divide by zero.");
      }
      // "of" multiplies, as "half of ten" does.
      const value: number = operator === "/" ? left.value / right.value : left.value * right.value;
      left = {
        value,
        text: operator === "of"
          ? `${wrapBinaryOperand(left, 2)} of ${wrapBinaryOperand(right, 2, true)}`
          : `${wrapBinaryOperand(left, 2)} ${operator === "*" ? "times" : "divided by"} ${wrapBinaryOperand(right, 2, true)}`,
        precedence: 2,
      };
    }
  }

  private parsePower(): ParsedScalarExpression | null {
    let left = this.parseUnary();
    if (!left) {
      return null;
    }
    if (this.peek() !== "^") {
      return left;
    }
    this.usedMath = true;
    this.index += 1;
    const right = this.parsePower();
    if (!right) {
      return null;
    }
    const value = left.value ** right.value;
    if (!Number.isFinite(value)) {
      throw new ScalarCalculationError("That blows out my local calculator.");
    }
    return {
      value,
      text: `${wrapBinaryOperand(left, 3)} to the power of ${wrapBinaryOperand(right, 3, true)}`,
      precedence: 3,
    };
  }

  private parseUnary(): ParsedScalarExpression | null {
    const operator = this.peek();
    if (operator === "-") {
      this.usedMath = true;
      this.index += 1;
      const operand = this.parseUnary();
      if (!operand) {
        return null;
      }
      return {
        value: -operand.value,
        text: `minus ${wrapUnaryOperand(operand)}`,
        precedence: 4,
      };
    }
    if (operator === "sqrt") {
      this.usedMath = true;
      this.index += 1;
      const operand = this.parseUnary();
      if (!operand) {
        return null;
      }
      if (operand.value < 0) {
        throw new ScalarCalculationError("I can't take the square root of a negative number.");
      }
      return {
        value: Math.sqrt(operand.value),
        text: `square root of ${wrapUnaryOperand(operand)}`,
        precedence: 4,
      };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ParsedScalarExpression | null {
    if (this.peek() === "(") {
      this.index += 1;
      const nested = this.parseExpression();
      if (!nested || this.peek() !== ")") {
        return null;
      }
      this.index += 1;
      return {
        value: nested.value,
        text: `(${nested.text})`,
        precedence: 5,
      };
    }
    const numeric = this.parseNumber();
    if (numeric === null) {
      return null;
    }
    let base: ParsedScalarExpression = {
      value: numeric,
      text: formatScalarCalculationValue(numeric),
      precedence: 5,
    };
    while (this.peek() === "%") {
      this.usedMath = true;
      this.index += 1;
      base = {
        value: base.value / 100,
        text: `${base.text} percent`,
        precedence: 4,
      };
    }
    return base;
  }

  private parseNumber(): number | null {
    const token = this.peek();
    if (!token) {
      return null;
    }
    if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token)) {
      this.index += 1;
      return Number(token);
    }
    const wordNumber = consumeWordNumber(this.tokens, this.index);
    if (!wordNumber) {
      return null;
    }
    this.index = wordNumber.nextIndex;
    return wordNumber.value;
  }

  private peek(): string | null {
    return this.tokens[this.index] ?? null;
  }
}

class ScalarCalculationError extends Error {}

function unwrapCalculationPrompt(input: string): string {
  let text = input
    .toLowerCase()
    .replaceAll(/[’']/g, "")
    .replaceAll(/√/g, " square root of ")
    .replaceAll(/(?<=[a-z])-(?=[a-z])/g, " ")
    .replaceAll(/[=?!,:]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
  if (!text) {
    return "";
  }
  text = text
    .replace(/^(?:in|using|with) (?:arithmetic|maths?|a calculation)\s+/, "")
    .replace(/^use (?:arithmetic|maths?) to (?:find|calculate|work out)\s+/, "");
  const calculationFrame = /^treat\s+(.+?)\s+as\s+(?:a\s+)?calculation$/.exec(text);
  if (calculationFrame?.[1]) {
    text = calculationFrame[1];
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of [
      householdRegex(String.raw`^(?:uh|um|hey\s+{ASSISTANT}|{ASSISTANT}|mate|please|right|okay|ok)\s+`),
      /^(?:can|could|would)\s+you\s+/,
      /^(?:answer this|answer this one|can you answer this)\s*:?\s+/,
      /^(?:go ahead(?: and)?|go on(?: and)?)\s+/,
      /^(?:just checking|quick one|quick maths|quick math)\s+/,
      /^i need (?:the )?answer to this\s+/,
      /^(?:fresh|new|separate) (?:calculation|sum|one)\s+/,
      /^start (?:fresh|over)(?: with)?\s+/,
      /^just\s+/,
    ]) {
      const next = text.replace(pattern, "");
      if (next !== text) {
        text = next.trim();
        changed = true;
      }
    }
  }
  text = text.replace(new RegExp(String.raw`\s+${POLITENESS_PATTERN}(?:\s+${POLITENESS_PATTERN})*$`), "");
  for (let index = 0; index < 4; index += 1) {
    const next = text
      .replace(/^(?:what do you get|what do you reckon)(?: for| if| when(?: you)?)?\s+/, "")
      .replace(/^(?:calculate|compute|work out|solve)\s+/, "")
      .replace(/^(?:evaluate|find)\s+/, "")
      .replace(/^what(?:s| is)\s+/, "")
      .replace(/^what does\s+(.+?)\s+(?:equal|make)$/, "$1")
      .replace(/^how much is\s+/, "")
      .replace(/^what\s+(?=\d)/, "")
      .trim();
    if (next === text) {
      break;
    }
    text = next;
  }
  text = text.replace(/^the\s+/, "");
  return text.trim();
}

function rewriteImperativeShape(text: string): string {
  const chainedMultiply = /^(.+?)\s+then\s+(?:multiply|multiplied)(?:\s+it)?\s+by\s+(.+)$/.exec(text);
  if (chainedMultiply?.[1] && chainedMultiply[2]) {
    return `(${rewriteImperativeShape(chainedMultiply[1])}) times ${rewriteImperativeShape(chainedMultiply[2])}`;
  }
  const chainedDivide = /^(.+?)\s+then\s+(?:divide|divided)(?:\s+it)?\s+by\s+(.+)$/.exec(text);
  if (chainedDivide?.[1] && chainedDivide[2]) {
    return `(${rewriteImperativeShape(chainedDivide[1])}) divided by ${rewriteImperativeShape(chainedDivide[2])}`;
  }
  const multipliedSum = /^(.+?)\s+(?:times|multiplied\s+by)\s+(?:the\s+)?sum\s+of\s+(.+?)\s+and\s+(.+)$/.exec(text);
  if (multipliedSum?.[1] && multipliedSum[2] && multipliedSum[3]) {
    return `${rewriteImperativeShape(multipliedSum[1])} times (${rewriteImperativeShape(multipliedSum[2])} plus ${rewriteImperativeShape(multipliedSum[3])})`;
  }
  const percentageIncrease = /^increase\s+(.+?)\s+by\s+(.+?)\s+(?:percent|%)$/.exec(text);
  if (percentageIncrease?.[1] && percentageIncrease[2]) {
    const base = rewriteImperativeShape(percentageIncrease[1]);
    return `${base} plus ${rewriteImperativeShape(percentageIncrease[2])} percent of ${groupNaturalOperand(base)}`;
  }
  const addedPercentageIncrease = /^add\s+(?:a|an|the)\s+(.+?)\s+(?:percent|%)\s+increase\s+to\s+(.+)$/.exec(text);
  if (addedPercentageIncrease?.[1] && addedPercentageIncrease[2]) {
    const base = rewriteImperativeShape(addedPercentageIncrease[2]);
    return `${base} plus ${rewriteImperativeShape(addedPercentageIncrease[1])} percent of ${groupNaturalOperand(base)}`;
  }
  const equalParts = /^divide\s+(.+?)\s+into\s+(.+?)\s+equal\s+parts?$/.exec(text);
  if (equalParts?.[1] && equalParts[2]) {
    return `${rewriteImperativeShape(equalParts[1])} divided by ${rewriteImperativeShape(equalParts[2])}`;
  }
  const fittingGroups = /^how\s+many\s+(.+?)\s+(?:fit|go)\s+into\s+(.+)$/.exec(text);
  if (fittingGroups?.[1] && fittingGroups[2]) {
    return `${rewriteImperativeShape(fittingGroups[2])} divided by ${singularNumericPhrase(fittingGroups[1])}`;
  }
  const lotsOf = /^(.+?)\s+lots?\s+of\s+(.+)$/.exec(text);
  if (lotsOf?.[1] && lotsOf[2]) {
    return `${rewriteImperativeShape(lotsOf[1])} times ${rewriteImperativeShape(lotsOf[2])}`;
  }
  const makeTogether = /^how\s+much\s+do\s+(.+?)\s+and\s+(.+?)\s+(?:make|come\s+to|add\s+up\s+to|total)(?:\s+together)?$/.exec(text);
  if (makeTogether?.[1] && makeTogether[2]) {
    return `${rewriteImperativeShape(makeTogether[1])} plus ${rewriteImperativeShape(makeTogether[2])}`;
  }
  const relationalSquareRoot = /^(?:what|which)\s+(?:positive\s+)?number\s+(?:that\s+)?(?:gives|makes|produces|equals)\s+(.+?)\s+when\s+(?:you\s+)?square\s+(?:it|that|the\s+number)$/.exec(text);
  if (relationalSquareRoot?.[1]) {
    return `square root of ${rewriteImperativeShape(relationalSquareRoot[1])}`;
  }
  const product = /^(.+?)\s+plus\s+(?:the\s+)?product\s+of\s+(.+?)\s+and\s+(.+)$/.exec(text);
  if (product?.[1] && product[2] && product[3]) {
    return `${product[1]} plus ${product[2]} times ${product[3]}`;
  }
  const sum = /^(?:sum|add)\s+(.+?)\s+and\s+(.+)$/.exec(text);
  if (sum?.[1] && sum[2]) {
    return `${sum[1]} plus ${sum[2]}`;
  }
  const add = /^add\s+(.+)\s+and\s+(.+)$/.exec(text);
  if (add?.[1] && add[2]) {
    return `${add[1]} plus ${add[2]}`;
  }
  const subtract = /^subtract\s+(.+)\s+from\s+(.+)$/.exec(text);
  if (subtract?.[1] && subtract[2]) {
    return `${subtract[2]} minus ${subtract[1]}`;
  }
  const takeAway = /^take\s+(.+?)\s+away\s+from\s+(.+)$/.exec(text);
  if (takeAway?.[1] && takeAway[2]) {
    return `${takeAway[2]} minus ${takeAway[1]}`;
  }
  const take = /^take\s+(.+)\s+from\s+(.+)$/.exec(text);
  if (take?.[1] && take[2]) {
    return `${take[2]} minus ${take[1]}`;
  }
  const remainsAfterSubtracting = /^how\s+much\s+remains\s+from\s+(.+?)\s+after\s+subtracting\s+(.+)$/.exec(text);
  if (remainsAfterSubtracting?.[1] && remainsAfterSubtracting[2]) {
    return `${remainsAfterSubtracting[1]} minus ${remainsAfterSubtracting[2]}`;
  }
  const remains = /^how much remains after taking\s+(.+?)\s+from\s+(.+)$/.exec(text);
  if (remains?.[1] && remains[2]) {
    return `${remains[2]} minus ${remains[1]}`;
  }
  const addedTo = /^(.+?)\s+added\s+to\s+(.+)$/.exec(text);
  if (addedTo?.[1] && addedTo[2]) {
    return `${addedTo[2]} plus ${addedTo[1]}`;
  }
  const addTo = /^add\s+(.+?)\s+to\s+(.+)$/.exec(text);
  if (addTo?.[1] && addTo[2]) {
    return `${addTo[2]} plus ${addTo[1]}`;
  }
  const multiply = /^multiply\s+(.+)\s+by\s+(.+)$/.exec(text);
  if (multiply?.[1] && multiply[2]) {
    return `${multiply[1]} times ${multiply[2]}`;
  }
  const divide = /^divide\s+(.+)\s+by\s+(.+)$/.exec(text);
  if (divide?.[1] && divide[2]) {
    return `${divide[1]} divided by ${divide[2]}`;
  }
  const positiveRoot = /^(?:the\s+)?positive\s+square\s+root\s+of\s+(.+)$/.exec(text);
  if (positiveRoot?.[1]) {
    return `square root of ${positiveRoot[1]}`;
  }
  const squaredIs = /^which number squared is\s+(.+)$/.exec(text);
  if (squaredIs?.[1]) {
    return `square root of ${squaredIs[1]}`;
  }
  const raised = /^(.+?)\s+raised\s+to\s+(.+)$/.exec(text);
  if (raised?.[1] && raised[2]) {
    return `${raised[1]} to the power of ${normalizePowerOperand(raised[2])}`;
  }
  const exponent = /^(.+?)\s+exponent\s+(.+)$/.exec(text);
  if (exponent?.[1] && exponent[2]) {
    return `${exponent[1]} to the power of ${normalizePowerOperand(exponent[2])}`;
  }
  const ordinalPower = /^(.+?)\s+to\s+(?:the\s+)?(.+?)(?:\s+power)?$/.exec(text);
  const ordinalExponent = ordinalPower?.[2]
    ? ordinalCardinalPhrase(ordinalPower[2])
    : null;
  if (ordinalPower?.[1] && ordinalExponent) {
    return `${ordinalPower[1]} to the power of ${ordinalExponent}`;
  }
  return text.replace(/^take\s+(?=.+\bpercent\b)/, "");
}

function normalizePowerOperand(value: string): string {
  const operand = value.replace(/^(?:the\s+)?power\s+of\s+/, "").trim();
  return ordinalCardinalPhrase(operand) ?? operand;
}

function ordinalCardinalPhrase(value: string): string | null {
  const tokens = value
    .replace(/^the\s+/, "")
    .replace(/\s+power$/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const ordinal = tokens.at(-1);
  const cardinal = ordinal ? ORDINAL_CARDINALS[ordinal] : null;
  if (!cardinal) return null;
  return [...tokens.slice(0, -1), cardinal].join(" ");
}

function groupNaturalOperand(value: string): string {
  return /\b(?:plus|minus|times|divided\s+by|percent\s+of)\b|[+\-*/]/.test(value)
    ? `(${value})`
    : value;
}

function singularNumericPhrase(value: string): string {
  const tokens = tokenizeCalculation(value);
  if (tokens.length === 0) {
    return value;
  }
  const last = tokens[tokens.length - 1] ?? "";
  const endings = [
    last.replace(/ies$/, "y"),
    last.replace(/es$/, ""),
    last.replace(/s$/, ""),
  ].filter((candidate) => candidate && candidate !== last);
  for (const ending of endings) {
    const candidate = [...tokens.slice(0, -1), ending];
    const parsed = consumeWordNumber(candidate, 0);
    if (parsed?.nextIndex === candidate.length) {
      return candidate.join(" ");
    }
  }
  return value;
}

const ORDINAL_CARDINALS: Readonly<Record<string, string>> = {
  first: "one",
  second: "two",
  third: "three",
  fourth: "four",
  fifth: "five",
  sixth: "six",
  seventh: "seven",
  eighth: "eight",
  ninth: "nine",
  tenth: "ten",
  eleventh: "eleven",
  twelfth: "twelve",
  thirteenth: "thirteen",
  fourteenth: "fourteen",
  fifteenth: "fifteen",
  sixteenth: "sixteen",
  seventeenth: "seventeen",
  eighteenth: "eighteen",
  nineteenth: "nineteen",
  twentieth: "twenty",
  thirtieth: "thirty",
  fortieth: "forty",
  fiftieth: "fifty",
  sixtieth: "sixty",
  seventieth: "seventy",
  eightieth: "eighty",
  ninetieth: "ninety",
  hundredth: "hundred",
  thousandth: "thousand",
  millionth: "million",
  billionth: "billion",
};

function hasSymbolicVariable(text: string): boolean {
  return /\b(?:x|y|z|n|t)\b/.test(text)
    || /\b(?:x|y|z|n|t)\s+(?:squared|cubed)\b/.test(text)
    || /\b(?:f|g|h)\s*\(\s*(?:x|y|z|n|t)\s*\)/.test(text);
}

interface UnitDefinition {
  readonly id: string;
  readonly label: string;
  readonly plural: string;
  readonly dimension: "length" | "mass" | "volume" | "temperature";
  readonly toBase: (value: number) => number;
  readonly fromBase: (value: number) => number;
}

interface ParsedQuantity {
  readonly amount: number;
  readonly units: readonly UnitDefinition[];
}

function resolveUnitConversion(text: string): ScalarCalculationResult | null {
  const normalized = text.replaceAll(/\s+/g, " ").trim();
  const howMany = /^how many\s+(.+?)\s+(?:are\s+)?in\s+(.+)$/.exec(normalized);
  if (howMany?.[1] && howMany[2]) {
    const targetUnits = resolveUnitAliases(howMany[1]);
    const sourceQuantity = parseQuantityWithUnit(howMany[2], true);
    return buildUnitConversionResult(sourceQuantity, targetUnits);
  }
  const howManyIs = /^how many\s+(.+?)\s+(?:is|are)\s+(.+)$/.exec(normalized);
  if (howManyIs?.[1] && howManyIs[2]) {
    const targetUnits = resolveUnitAliases(howManyIs[1]);
    const sourceQuantity = parseQuantityWithUnit(howManyIs[2], true);
    return buildUnitConversionResult(sourceQuantity, targetUnits);
  }
  const convert = /^(?:convert|what is)\s+(.+?)\s+(?:in|to)\s+(.+)$/.exec(normalized);
  if (convert?.[1] && convert[2]) {
    const sourceQuantity = parseQuantityWithUnit(convert[1], false);
    const targetUnits = resolveUnitAliases(convert[2]);
    return buildUnitConversionResult(sourceQuantity, targetUnits);
  }
  const bare = /^(.+?)\s+(?:in|to)\s+(.+)$/.exec(normalized);
  if (bare?.[1] && bare[2]) {
    const sourceQuantity = parseQuantityWithUnit(bare[1], false);
    const targetUnits = resolveUnitAliases(bare[2]);
    return buildUnitConversionResult(sourceQuantity, targetUnits);
  }
  return null;
}

function parseQuantityWithUnit(text: string, allowDefaultOne: boolean): ParsedQuantity | null {
  const tokens = tokenizeCalculation(text);
  if (tokens.length === 0) {
    return null;
  }
  if ((tokens[0] === "a" || tokens[0] === "an") && allowDefaultOne) {
    const units = resolveUnitAliases(tokens.slice(1).join(" "));
    return units.length > 0 ? { amount: 1, units } : null;
  }
  const wordNumber = consumeWordNumber(tokens, 0);
  if (wordNumber) {
    const units = resolveUnitAliases(tokens.slice(wordNumber.nextIndex).join(" "));
    return units.length > 0 ? { amount: wordNumber.value, units } : null;
  }
  if (/^\d+(?:\.\d+)?$/.test(tokens[0] ?? "")) {
    const units = resolveUnitAliases(tokens.slice(1).join(" "));
    return units.length > 0 ? { amount: Number(tokens[0]), units } : null;
  }
  if (!allowDefaultOne) {
    return null;
  }
  const units = resolveUnitAliases(tokens.join(" "));
  return units.length > 0 ? { amount: 1, units } : null;
}

function resolveUnitAliases(text: string): readonly UnitDefinition[] {
  const normalized = text
    .toLowerCase()
    .replaceAll(/\bdegrees?\b/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  const direct = UNIT_ALIASES.get(normalized);
  if (direct) {
    return direct;
  }
  const singular = normalized.replace(/\bfeet\b/g, "foot").replace(/\binches\b/g, "inch").replace(/s\b/g, "").trim();
  return UNIT_ALIASES.get(singular) ?? [];
}

function convertUnitValue(value: number, source: UnitDefinition, target: UnitDefinition): number {
  return normalizeOutputValue(target.fromBase(source.toBase(value)));
}

function formatConversionValue(value: number): string {
  if (Math.abs(value) >= 100) {
    return String(Math.round(value * 100) / 100).replace(/\.0+$/, "");
  }
  return String(Math.round(value * 10_000) / 10_000).replace(/\.?0+$/, "");
}

function displayUnitLabel(value: number, unit: UnitDefinition): string {
  const amount = Math.abs(value);
  return amount === 1 ? unit.label : unit.plural;
}

function buildUnitConversionResult(
  sourceQuantity: ParsedQuantity | null,
  targetUnits: readonly UnitDefinition[],
): ScalarCalculationResult | null {
  if (!sourceQuantity || targetUnits.length === 0) {
    return null;
  }
  const sourceUnits = sourceQuantity.units;
  const dimension = sourceUnits[0]?.dimension ?? null;
  if (!dimension || !sourceUnits.every((unit) => unit.dimension === dimension) || !targetUnits.every((unit) => unit.dimension === dimension)) {
    return null;
  }
  if (sourceUnits.length === 1 && targetUnits.length === 1) {
    const sourceUnit = sourceUnits[0] as UnitDefinition;
    const targetUnit = targetUnits[0] as UnitDefinition;
    const value = convertUnitValue(sourceQuantity.amount, sourceUnit, targetUnit);
    const formatted = formatConversionValue(value);
    return {
      status: "ok",
      expression: `${formatScalarCalculationValue(sourceQuantity.amount)} ${displayUnitLabel(sourceQuantity.amount, sourceUnit)} in ${displayUnitLabel(2, targetUnit)}`,
      value,
      text: `${formatScalarCalculationValue(sourceQuantity.amount)} ${displayUnitLabel(sourceQuantity.amount, sourceUnit)} is ${formatted} ${displayUnitLabel(value, targetUnit)}.`,
    };
  }
  if (sourceUnits.length === 2 && targetUnits.length === 1) {
    const targetUnit = targetUnits[0] as UnitDefinition;
    const parts = sourceUnits.map((unit) => {
      const converted = convertUnitValue(sourceQuantity.amount, unit, targetUnit);
      return `${capitalize(unit.label)} is ${formatConversionValue(converted)} ${displayUnitLabel(converted, targetUnit)}`;
    });
    return {
      status: "ok",
      expression: `${displayUnitLabel(sourceQuantity.amount, sourceUnits[0] as UnitDefinition)} in ${displayUnitLabel(2, targetUnit)}`,
      value: null,
      text: `${parts.join(". ")}.`,
    };
  }
  return null;
}

function tokenizeCalculation(text: string): readonly string[] {
  const normalized = text
    .replaceAll(/,/g, "")
    .replaceAll(/÷/g, "/")
    .replaceAll(/×/g, " * ")
    .replaceAll(/−/g, "-")
    .replaceAll(/\s+/g, " ")
    .trim();
  return normalized.match(/(?:\d+(?:\.\d+)?|\.\d+)|[a-z]+|[%()+\-*/^]/g) ?? [];
}

function normalizeCalculationTokens(tokens: readonly string[]): readonly string[] {
  const output: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const next = tokens[index + 1] ?? "";
    const nextTwo = tokens[index + 2] ?? "";
    const nextThree = tokens[index + 3] ?? "";
    const fraction = consumeFractionPhrase(tokens, index);
    if (fraction) {
      output.push(
        "(",
        formatScalarCalculationValue(fraction.numerator),
        "/",
        formatScalarCalculationValue(fraction.denominator),
        ")",
        "*",
      );
      index = fraction.nextIndex - 1;
      continue;
    }
    if (token === "open" && (next === "bracket" || next === "parenthesis")) {
      output.push("(");
      index += 1;
      continue;
    }
    if (token === "close" && (next === "bracket" || next === "parenthesis")) {
      output.push(")");
      index += 1;
      continue;
    }
    if (token === "to" && next === "the" && nextTwo === "power" && nextThree === "of") {
      output.push("^");
      index += 3;
      continue;
    }
    if (token === "power" && next === "of") {
      output.push("^");
      index += 1;
      continue;
    }
    if (token === "multiplied" && next === "by") {
      output.push("*");
      index += 1;
      continue;
    }
    if (token === "divided" && next === "by") {
      output.push("/");
      index += 1;
      continue;
    }
    if (token === "square" && next === "root" && nextTwo === "of") {
      output.push("sqrt");
      index += 2;
      continue;
    }
    if (token === "square" && next === "root") {
      output.push("sqrt");
      index += 1;
      continue;
    }
    if (token === "sqrt" && next === "of") {
      output.push("sqrt");
      index += 1;
      continue;
    }
    if ((token === "half" || token === "quarter") && next === "of") {
      output.push(token === "half" ? "0.5" : "0.25", "*");
      index += 1;
      continue;
    }
    if (token === "plus" || token === "add" || token === "added") {
      output.push("+");
      continue;
    }
    if (token === "minus" || token === "less") {
      output.push("-");
      continue;
    }
    if (token === "times" || token === "x") {
      output.push("*");
      continue;
    }
    if (token === "over") {
      output.push("/");
      continue;
    }
    if (token === "percent" || token === "percentage") {
      output.push("%");
      continue;
    }
    if (token === "per" && next === "cent") {
      output.push("%");
      index += 1;
      continue;
    }
    if (token === "squared") {
      output.push("^", "2");
      continue;
    }
    if (token === "cubed") {
      output.push("^", "3");
      continue;
    }
    output.push(token);
  }
  return output;
}

interface FractionPhrase {
  readonly numerator: number;
  readonly denominator: number;
  readonly nextIndex: number;
}

const FRACTION_DENOMINATORS: Readonly<Record<string, number>> = {
  half: 2,
  halves: 2,
  third: 3,
  thirds: 3,
  quarter: 4,
  quarters: 4,
  fourth: 4,
  fourths: 4,
  fifth: 5,
  fifths: 5,
  sixth: 6,
  sixths: 6,
  seventh: 7,
  sevenths: 7,
  eighth: 8,
  eighths: 8,
  ninth: 9,
  ninths: 9,
  tenth: 10,
  tenths: 10,
};

function consumeFractionPhrase(tokens: readonly string[], startIndex: number): FractionPhrase | null {
  let numerator = 1;
  let denominatorIndex = startIndex;
  if (tokens[startIndex] === "a" || tokens[startIndex] === "an") {
    denominatorIndex += 1;
  } else {
    const parsedNumerator = consumeWordNumber(tokens, startIndex);
    if (parsedNumerator) {
      numerator = parsedNumerator.value;
      denominatorIndex = parsedNumerator.nextIndex;
    }
  }
  const denominator = FRACTION_DENOMINATORS[tokens[denominatorIndex] ?? ""];
  if (!denominator || tokens[denominatorIndex + 1] !== "of") {
    return null;
  }
  return {
    numerator,
    denominator,
    nextIndex: denominatorIndex + 2,
  };
}

function isMathSignalToken(token: string): boolean {
  return token === "+"
    || token === "-"
    || token === "*"
    || token === "/"
    || token === "^"
    || token === "%"
    || token === "sqrt"
    || token === "of";
}

function consumeWordNumber(tokens: readonly string[], startIndex: number): { readonly value: number; readonly nextIndex: number } | null {
  let index = startIndex;
  let sign = 1;
  if (tokens[index] === "minus" || tokens[index] === "negative") {
    sign = -1;
    index += 1;
  }
  let total = 0;
  let current = 0;
  let sawNumber = false;
  let decimal = "";
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token === "and" && sawNumber && !decimal) {
      index += 1;
      continue;
    }
    const small = SMALL_NUMBER_WORDS[token];
    if (small !== undefined) {
      current += small;
      sawNumber = true;
      index += 1;
      continue;
    }
    const tens = TENS_NUMBER_WORDS[token];
    if (tens !== undefined) {
      current += tens;
      sawNumber = true;
      index += 1;
      continue;
    }
    if (token === "hundred") {
      current = (current || 1) * 100;
      sawNumber = true;
      index += 1;
      continue;
    }
    const scale = LARGE_NUMBER_WORDS[token];
    if (scale !== undefined) {
      total += (current || 1) * scale;
      current = 0;
      sawNumber = true;
      index += 1;
      continue;
    }
    if (token === "point") {
      sawNumber = true;
      index += 1;
      while (index < tokens.length) {
        const digitToken = tokens[index] ?? "";
        if (/^\d+$/.test(digitToken)) {
          decimal += digitToken;
          index += 1;
          continue;
        }
        const digitWord = DIGIT_WORDS[digitToken];
        if (digitWord !== undefined) {
          decimal += String(digitWord);
          index += 1;
          continue;
        }
        break;
      }
      break;
    }
    break;
  }
  if (!sawNumber) {
    return null;
  }
  const value = sign * (total + current + (decimal ? Number(`0.${decimal}`) : 0));
  return { value, nextIndex: index };
}

function wrapBinaryOperand(expression: ParsedScalarExpression, precedence: number, rightAssociative = false): string {
  if (expression.precedence < precedence || (rightAssociative && expression.precedence === precedence)) {
    return `(${expression.text})`;
  }
  return expression.text;
}

function wrapUnaryOperand(expression: ParsedScalarExpression): string {
  return expression.precedence < 4 ? `(${expression.text})` : expression.text;
}

function normalizeOutputValue(value: number): number {
  if (Math.abs(value) < 1e-12) {
    return 0;
  }
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function roundToPlaces(value: number, places: number): number {
  const factor = 10 ** places;
  return normalizeOutputValue(Math.round(value * factor) / factor);
}

const SMALL_NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS_NUMBER_WORDS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const LARGE_NUMBER_WORDS: Readonly<Record<string, number>> = {
  thousand: 1_000,
  million: 1_000_000,
  billion: 1_000_000_000,
};

/** Spoken digits: zero to nine, and "oh". */
const DIGIT_WORDS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(Object.entries(SMALL_NUMBER_WORDS).filter(([, value]) => value < 10)),
  oh: 0,
};

const LITRE: UnitDefinition = {
  id: "litre",
  label: "litre",
  plural: "litres",
  dimension: "volume",
  toBase: (value) => value,
  fromBase: (value) => value,
};

const MILLILITRE: UnitDefinition = {
  id: "millilitre",
  label: "millilitre",
  plural: "millilitres",
  dimension: "volume",
  toBase: (value) => value / 1000,
  fromBase: (value) => value * 1000,
};

const US_GALLON: UnitDefinition = {
  id: "us_gallon",
  label: "US gallon",
  plural: "US gallons",
  dimension: "volume",
  toBase: (value) => value * 3.785411784,
  fromBase: (value) => value / 3.785411784,
};

const IMPERIAL_GALLON: UnitDefinition = {
  id: "imperial_gallon",
  label: "imperial gallon",
  plural: "imperial gallons",
  dimension: "volume",
  toBase: (value) => value * 4.54609,
  fromBase: (value) => value / 4.54609,
};

const METRE: UnitDefinition = {
  id: "metre",
  label: "metre",
  plural: "metres",
  dimension: "length",
  toBase: (value) => value,
  fromBase: (value) => value,
};

const KILOMETRE: UnitDefinition = {
  id: "kilometre",
  label: "kilometre",
  plural: "kilometres",
  dimension: "length",
  toBase: (value) => value * 1000,
  fromBase: (value) => value / 1000,
};

const CENTIMETRE: UnitDefinition = {
  id: "centimetre",
  label: "centimetre",
  plural: "centimetres",
  dimension: "length",
  toBase: (value) => value / 100,
  fromBase: (value) => value * 100,
};

const MILE: UnitDefinition = {
  id: "mile",
  label: "mile",
  plural: "miles",
  dimension: "length",
  toBase: (value) => value * 1609.344,
  fromBase: (value) => value / 1609.344,
};

const FOOT: UnitDefinition = {
  id: "foot",
  label: "foot",
  plural: "feet",
  dimension: "length",
  toBase: (value) => value * 0.3048,
  fromBase: (value) => value / 0.3048,
};

const INCH: UnitDefinition = {
  id: "inch",
  label: "inch",
  plural: "inches",
  dimension: "length",
  toBase: (value) => value * 0.0254,
  fromBase: (value) => value / 0.0254,
};

const KILOGRAM: UnitDefinition = {
  id: "kilogram",
  label: "kilogram",
  plural: "kilograms",
  dimension: "mass",
  toBase: (value) => value,
  fromBase: (value) => value,
};

const GRAM: UnitDefinition = {
  id: "gram",
  label: "gram",
  plural: "grams",
  dimension: "mass",
  toBase: (value) => value / 1000,
  fromBase: (value) => value * 1000,
};

const POUND: UnitDefinition = {
  id: "pound",
  label: "pound",
  plural: "pounds",
  dimension: "mass",
  toBase: (value) => value * 0.45359237,
  fromBase: (value) => value / 0.45359237,
};

const OUNCE: UnitDefinition = {
  id: "ounce",
  label: "ounce",
  plural: "ounces",
  dimension: "mass",
  toBase: (value) => value * 0.028349523125,
  fromBase: (value) => value / 0.028349523125,
};

const CELSIUS: UnitDefinition = {
  id: "celsius",
  label: "degree Celsius",
  plural: "degrees Celsius",
  dimension: "temperature",
  toBase: (value) => value,
  fromBase: (value) => value,
};

const FAHRENHEIT: UnitDefinition = {
  id: "fahrenheit",
  label: "degree Fahrenheit",
  plural: "degrees Fahrenheit",
  dimension: "temperature",
  toBase: (value) => (value - 32) * (5 / 9),
  fromBase: (value) => (value * (9 / 5)) + 32,
};

const UNIT_ALIASES = new Map<string, readonly UnitDefinition[]>([
  ["litre", [LITRE]],
  ["litres", [LITRE]],
  ["liter", [LITRE]],
  ["liters", [LITRE]],
  ["l", [LITRE]],
  ["millilitre", [MILLILITRE]],
  ["millilitres", [MILLILITRE]],
  ["milliliter", [MILLILITRE]],
  ["milliliters", [MILLILITRE]],
  ["ml", [MILLILITRE]],
  ["gallon", [US_GALLON, IMPERIAL_GALLON]],
  ["gallons", [US_GALLON, IMPERIAL_GALLON]],
  ["gal", [US_GALLON, IMPERIAL_GALLON]],
  ["us gallon", [US_GALLON]],
  ["us gallons", [US_GALLON]],
  ["american gallon", [US_GALLON]],
  ["american gallons", [US_GALLON]],
  ["imperial gallon", [IMPERIAL_GALLON]],
  ["imperial gallons", [IMPERIAL_GALLON]],
  ["metre", [METRE]],
  ["metres", [METRE]],
  ["meter", [METRE]],
  ["meters", [METRE]],
  ["m", [METRE]],
  ["kilometre", [KILOMETRE]],
  ["kilometres", [KILOMETRE]],
  ["kilometer", [KILOMETRE]],
  ["kilometers", [KILOMETRE]],
  ["km", [KILOMETRE]],
  ["centimetre", [CENTIMETRE]],
  ["centimetres", [CENTIMETRE]],
  ["centimeter", [CENTIMETRE]],
  ["centimeters", [CENTIMETRE]],
  ["cm", [CENTIMETRE]],
  ["mile", [MILE]],
  ["miles", [MILE]],
  ["mi", [MILE]],
  ["foot", [FOOT]],
  ["feet", [FOOT]],
  ["ft", [FOOT]],
  ["inch", [INCH]],
  ["inches", [INCH]],
  ["in", [INCH]],
  ["kilogram", [KILOGRAM]],
  ["kilograms", [KILOGRAM]],
  ["kilo", [KILOGRAM]],
  ["kilos", [KILOGRAM]],
  ["kg", [KILOGRAM]],
  ["gram", [GRAM]],
  ["grams", [GRAM]],
  ["g", [GRAM]],
  ["pound", [POUND]],
  ["pounds", [POUND]],
  ["lb", [POUND]],
  ["lbs", [POUND]],
  ["ounce", [OUNCE]],
  ["ounces", [OUNCE]],
  ["oz", [OUNCE]],
  ["celsius", [CELSIUS]],
  ["centigrade", [CELSIUS]],
  ["c", [CELSIUS]],
  ["fahrenheit", [FAHRENHEIT]],
  ["f", [FAHRENHEIT]],
]);
