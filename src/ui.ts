import { createInterface } from "node:readline/promises";
import { env, stdin, stdout } from "node:process";

/**
 * Dependency-free terminal presentation layer for Rogue's first-run, model, and
 * authentication flows. Everything degrades to plain lines when the process is
 * piped, NO_COLOR is set, or the terminal is not interactive, so unattended
 * provisioning keeps working unchanged.
 */

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

function detectColor(): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR) return true;
  if (env.TERM === "dumb") return false;
  return Boolean(stdout.isTTY);
}

export const colorEnabled = detectColor();
const trueColor = colorEnabled && /truecolor|24bit/i.test(env.COLORTERM ?? "");
export const interactive = Boolean(stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === "function");

interface Ink {
  /** 24-bit value used when the terminal advertises truecolor. */
  rgb: [number, number, number];
  /** 256-color approximation used everywhere else. */
  code: number;
}

const INK = {
  violet: { rgb: [167, 139, 250], code: 141 },
  cyan: { rgb: [34, 211, 238], code: 80 },
  green: { rgb: [74, 222, 128], code: 114 },
  amber: { rgb: [251, 191, 36], code: 179 },
  red: { rgb: [248, 113, 113], code: 203 },
  slate: { rgb: [148, 163, 184], code: 245 },
  faint: { rgb: [100, 116, 139], code: 242 },
} satisfies Record<string, Ink>;

function foreground(ink: Ink): string {
  if (!colorEnabled) return "";
  if (trueColor) return `\x1b[38;2;${ink.rgb[0]};${ink.rgb[1]};${ink.rgb[2]}m`;
  return `\x1b[38;5;${ink.code}m`;
}

function tint(value: string, ink: Ink): string {
  return colorEnabled ? `${foreground(ink)}${value}\x1b[39m` : value;
}

function wrap(value: string, open: string, close: string): string {
  return colorEnabled ? `\x1b[${open}m${value}\x1b[${close}m` : value;
}

export const style = {
  bold: (value: string): string => wrap(value, "1", "22"),
  underline: (value: string): string => wrap(value, "4", "24"),
  accent: (value: string): string => tint(value, INK.violet),
  info: (value: string): string => tint(value, INK.cyan),
  success: (value: string): string => tint(value, INK.green),
  warning: (value: string): string => tint(value, INK.amber),
  danger: (value: string): string => tint(value, INK.red),
  muted: (value: string): string => tint(value, INK.slate),
  faint: (value: string): string => tint(value, INK.faint),
};

/** Interpolated violet → cyan ramp used for the wordmark and rules. */
function rampInk(position: number): Ink {
  const clamped = Math.max(0, Math.min(1, position));
  const from = INK.violet.rgb;
  const to = INK.cyan.rgb;
  const codes = [141, 140, 105, 104, 68, 74, 80, 44];
  return {
    rgb: [
      Math.round(from[0] + (to[0] - from[0]) * clamped),
      Math.round(from[1] + (to[1] - from[1]) * clamped),
      Math.round(from[2] + (to[2] - from[2]) * clamped),
    ],
    code: codes[Math.min(codes.length - 1, Math.round(clamped * (codes.length - 1)))]!,
  };
}

export function gradient(value: string): string {
  if (!colorEnabled) return value;
  const characters = [...value];
  const last = Math.max(1, characters.length - 1);
  return characters.map((character, index) => tint(character, rampInk(index / last))).join("");
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function characterWidth(codePoint: number): number {
  if (codePoint === 0x200d || codePoint === 0xfe0f || codePoint === 0xfe0e) return 0;
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0;
  if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) return 1; // regional indicators pair into one flag
  if (codePoint >= 0x1100 && codePoint <= 0x115f) return 2;
  if (codePoint >= 0x2e80 && codePoint <= 0xa4cf) return 2;
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return 2;
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 2;
  if (codePoint >= 0xfe30 && codePoint <= 0xfe4f) return 2;
  if (codePoint >= 0xff00 && codePoint <= 0xff60) return 2;
  if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return 2;
  if (codePoint >= 0x1f300 && codePoint <= 0x1faff) return 2;
  return 1;
}

/** Column count a string occupies once ANSI styling is removed. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const character of stripAnsi(value)) width += characterWidth(character.codePointAt(0)!);
  return width;
}

/**
 * Truncate to a column budget, adding an ellipsis when cut. Styling sequences
 * cost no columns and are preserved, so styled labels stay intact.
 */
export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  let result = "";
  let used = 0;
  let styled = false;
  const characters = [...value];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    if (character === "\x1b") {
      let sequence = character;
      while (index + 1 < characters.length) {
        const next = characters[++index]!;
        sequence += next;
        if (/[A-Za-z]/.test(next)) break;
      }
      result += sequence;
      styled = true;
      continue;
    }
    const size = characterWidth(character.codePointAt(0)!);
    if (used + size > width - 1) break;
    result += character;
    used += size;
  }
  return `${result}…${styled && colorEnabled ? "\x1b[0m" : ""}`;
}

/** Word-wrap plain text to a column budget, truncating the final allowed line. */
export function wrapText(value: string, width: number, maxLines = 2): string[] {
  if (width <= 0 || !value) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (displayWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) break;
  }
  if (lines.length < maxLines && current) lines.push(current);
  const consumed = lines.join(" ");
  if (consumed.length < value.length && lines.length === maxLines) {
    const remainder = value.slice(Math.max(0, consumed.length)).trim();
    if (remainder) lines[maxLines - 1] = truncate(`${lines[maxLines - 1]} ${remainder}`, width);
  }
  return lines.map((line) => truncate(line, width));
}

export function pad(value: string, width: number): string {
  const missing = width - displayWidth(value);
  return missing > 0 ? value + " ".repeat(missing) : value;
}

export function terminalWidth(): number {
  return Math.max(48, Math.min(stdout.columns || 80, 100));
}

function terminalRows(): number {
  return stdout.rows || 24;
}

export function write(line = ""): void {
  stdout.write(`${line}\n`);
}

/** Rogue wordmark plus tagline, framed in the violet → cyan ramp. */
export function logo(tagline = "autonomous agents · defined by their own database"): void {
  const inner = Math.max(displayWidth(tagline), 26) + 4;
  const top = `╭${"─".repeat(inner)}╮`;
  const bottom = `╰${"─".repeat(inner)}╯`;
  const wordmark = "R O G U E";
  write();
  write(`  ${gradient(top)}`);
  write(
    `  ${gradient("│")}  ${style.bold(gradient(wordmark))}${" ".repeat(Math.max(0, inner - 2 - displayWidth(wordmark)))}${gradient("│")}`,
  );
  write(
    `  ${gradient("│")}  ${style.faint(tagline)}${" ".repeat(Math.max(0, inner - 2 - displayWidth(tagline)))}${gradient("│")}`,
  );
  write(`  ${gradient(bottom)}`);
  write();
}

/**
 * Progress rail for multi-stage setup, e.g. `✔ Identity ── ◆ Model ── ◇ Network`.
 * `current` is zero-based; every earlier stage renders as complete.
 */
export function steps(labels: readonly string[], current: number): void {
  const parts = labels.map((label, index) => {
    if (index < current) return `${style.success("✔")} ${style.faint(label)}`;
    if (index === current) return `${style.accent("◆")} ${style.bold(label)}`;
    return `${style.faint("◇")} ${style.faint(label)}`;
  });
  write(`  ${parts.join(style.faint("  ──  "))}`);
  write();
}

export function heading(title: string, subtitle?: string): void {
  write(`  ${style.accent("▌")} ${style.bold(title)}`);
  if (subtitle) write(`  ${style.accent("▌")} ${style.faint(subtitle)}`);
  write();
}

export function info(message: string): void {
  write(`  ${style.info("›")} ${message}`);
}

export function success(message: string): void {
  write(`  ${style.success("✔")} ${message}`);
}

export function warn(message: string): void {
  write(`  ${style.warning("!")} ${message}`);
}

export function fail(message: string): void {
  write(`  ${style.danger("✖")} ${message}`);
}

export function hint(message: string): void {
  write(`  ${style.faint(message)}`);
}

/** Aligned label/value panel used for setup summaries. */
export function panel(title: string, rows: readonly (readonly [string, string])[]): void {
  const labelWidth = rows.reduce((widest, [label]) => Math.max(widest, displayWidth(label)), 0);
  const budget = terminalWidth() - labelWidth - 8;
  write();
  write(`  ${style.accent("┌")} ${style.bold(title)}`);
  for (const [label, value] of rows) {
    write(`  ${style.accent("│")} ${style.faint(pad(label, labelWidth))}  ${truncate(value, budget)}`);
  }
  write(`  ${style.accent("└")}`);
  write();
}

/** Inline list of short values, e.g. configured relays. */
export function chips(values: readonly string[]): void {
  if (!values.length) return;
  const budget = terminalWidth() - 6;
  let line = "";
  for (const value of values) {
    const chip = ` ${truncate(value, budget - 4)} `;
    if (displayWidth(line) + displayWidth(chip) + 2 > budget) {
      write(`  ${line}`);
      line = "";
    }
    line += `${style.info("[")}${chip}${style.info("]")} `;
  }
  if (line.trim()) write(`  ${line}`);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Run an async task behind a spinner, leaving one summary line behind. */
export async function withSpinner<T>(
  label: string,
  task: () => Promise<T>,
  describe?: (value: T) => string | undefined,
): Promise<T> {
  if (!interactive) {
    const value = await task();
    hint(describe?.(value) ?? label);
    return value;
  }
  let frame = 0;
  stdout.write("\x1b[?25l");
  const render = (): void => {
    stdout.write(`\r\x1b[2K  ${style.accent(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!)} ${style.faint(label)}`);
    frame += 1;
  };
  render();
  const timer = setInterval(render, 80);
  const clear = (): void => {
    clearInterval(timer);
    stdout.write("\r\x1b[2K\x1b[?25h");
  };
  try {
    const value = await task();
    clear();
    const summary = describe?.(value);
    if (summary) hint(summary);
    return value;
  } catch (error) {
    clear();
    fail(label);
    throw error;
  }
}

export interface SelectItem {
  id: string;
  label: string;
  /** Right-aligned tag, typically a stable identifier such as a provider ID. */
  badge?: string;
  description?: string;
  /** Extra lines shown in the detail pane while this item has focus. */
  detail?: string[];
  /** Additional terms matched by the filter but never displayed. */
  searchText?: string;
}

export interface SelectOptions<T extends SelectItem> {
  title: string;
  subtitle?: string;
  items: readonly T[];
  /** Noun printed with the confirmation line once a choice is made. */
  confirmLabel?: string;
  initialQuery?: string;
  emptyMessage?: string;
}

export function filterItems<T extends SelectItem>(items: readonly T[], query: string): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...items];
  return items.filter((item) => {
    const haystack = stripAnsi(`${item.id} ${item.label} ${item.badge ?? ""} ${item.description ?? ""} ${item.searchText ?? ""}`)
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * Split a raw read into individual keys. Escape sequences stay intact, and
 * everything else is emitted one code point at a time so a chunk carrying
 * several keystrokes is not mistaken for a single unknown key.
 */
export function parseKeys(data: string): string[] {
  const keys: string[] = [];
  const characters = [...data];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    if (character !== "\x1b") {
      keys.push(character);
      continue;
    }
    const next = characters[index + 1];
    if (next === "[" || next === "O") {
      let sequence = character + next;
      index += 1;
      while (index + 1 < characters.length) {
        const part = characters[++index]!;
        sequence += part;
        if (/[A-Za-z~]/.test(part)) break;
      }
      keys.push(sequence);
      continue;
    }
    keys.push(character);
  }
  return keys;
}

export class CancelledError extends Error {
  constructor(message = "Setup cancelled.") {
    super(message);
    this.name = "CancelledError";
  }
}

function confirmation(label: string | undefined, item: SelectItem): void {
  const noun = label ? `${style.faint(`${label} ·`)} ` : "";
  write(`  ${style.success("✔")} ${noun}${style.bold(item.label)}${item.badge ? ` ${style.faint(item.badge)}` : ""}`);
}

/**
 * Filterable, arrow-key list. Falls back to a numbered prompt whenever the
 * process lacks a raw-mode-capable TTY.
 */
export async function select<T extends SelectItem>(options: SelectOptions<T>): Promise<T> {
  if (!options.items.length) throw new Error(`No options are available for ${options.title.toLocaleLowerCase()}.`);
  return interactive ? interactiveSelect(options) : lineSelect(options);
}

async function interactiveSelect<T extends SelectItem>(options: SelectOptions<T>): Promise<T> {
  const hasDescriptions = options.items.some((item) => item.description);
  let query = options.initialQuery ?? "";
  let matches = filterItems(options.items, query);
  let cursor = 0;
  let offset = 0;
  let rendered = 0;

  const rowsPerItem = hasDescriptions ? 2 : 1;
  const viewportSize = (): number => {
    const detailLines = options.items.some((item) => item.detail?.length) ? 7 : 0;
    const chrome = 8 + detailLines;
    const available = Math.floor((terminalRows() - chrome) / rowsPerItem);
    return Math.max(3, Math.min(hasDescriptions ? 8 : 12, available));
  };

  const build = (): string[] => {
    const width = terminalWidth();
    const size = viewportSize();
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + size) offset = cursor - size + 1;
    offset = Math.max(0, Math.min(offset, Math.max(0, matches.length - size)));
    const visible = matches.slice(offset, offset + size);

    const lines: string[] = [];
    lines.push("");
    lines.push(`  ${style.accent("▌")} ${style.bold(truncate(options.title, width - 6))}`);
    if (options.subtitle) lines.push(`  ${style.accent("▌")} ${style.faint(truncate(options.subtitle, width - 6))}`);
    const counter = `${matches.length}/${options.items.length}`;
    lines.push(
      `  ${style.accent("▌")} ${style.faint("filter")} ${query ? truncate(query, width - 24) : style.faint("(type to search)")}${
        style.accent("▏")
      }   ${style.faint(counter)}`,
    );
    lines.push("");

    if (!visible.length) {
      lines.push(`    ${style.warning(options.emptyMessage ?? "No matches. Press ⌫ to widen the search.")}`);
    }

    for (const [index, item] of visible.entries()) {
      const focused = offset + index === cursor;
      const badge = item.badge && item.badge !== item.label ? item.badge : "";
      const labelBudget = width - 8 - (badge ? displayWidth(badge) + 2 : 0);
      const label = truncate(item.label, Math.max(8, labelBudget));
      const gap = Math.max(1, width - 6 - displayWidth(label) - displayWidth(badge));
      const marker = focused ? style.accent("❯") : " ";
      const painted = focused ? style.bold(style.accent(label)) : label;
      lines.push(`  ${marker} ${painted}${" ".repeat(gap)}${style.faint(badge)}`);
      if (hasDescriptions) {
        const description = item.description ? truncate(item.description, width - 8) : "";
        lines.push(`    ${focused ? style.muted(description) : style.faint(description)}`);
      }
    }

    const above = offset;
    const below = Math.max(0, matches.length - offset - visible.length);
    if (above || below) {
      const parts = [above ? `↑ ${above} above` : "", below ? `↓ ${below} below` : ""].filter(Boolean);
      lines.push(`    ${style.faint(parts.join(" · "))}`);
    }

    const focusedItem = matches[cursor];
    if (focusedItem?.detail?.length) {
      lines.push("");
      let budget = 6;
      for (const detail of focusedItem.detail) {
        for (const wrapped of wrapText(detail, width - 6, Math.min(2, budget))) {
          lines.push(`  ${style.accent("│")} ${style.muted(wrapped)}`);
          budget -= 1;
        }
        if (budget <= 0) break;
      }
    }

    lines.push("");
    lines.push(`  ${style.faint("↑↓ move · type to filter · ⏎ select · esc cancel")}`);
    return lines.map((line) => (displayWidth(line) > width ? truncate(line, width) : line));
  };

  const draw = (): void => {
    const lines = build();
    const chunks: string[] = [];
    if (rendered) chunks.push(`\x1b[${rendered}A`);
    for (const line of lines) chunks.push(`\x1b[2K${line}\n`);
    if (rendered > lines.length) {
      const extra = rendered - lines.length;
      chunks.push("\x1b[2K\n".repeat(extra));
      chunks.push(`\x1b[${extra}A`);
    }
    rendered = lines.length;
    stdout.write(chunks.join(""));
  };

  const erase = (): void => {
    if (!rendered) return;
    stdout.write(`\x1b[${rendered}A${"\x1b[2K\n".repeat(rendered)}\x1b[${rendered}A`);
    rendered = 0;
  };

  stdout.write("\x1b[?25l");
  stdin.setRawMode?.(true);
  stdin.resume();
  draw();

  return new Promise<T>((resolve, reject) => {
    const finish = (outcome: () => void): void => {
      stdin.off("data", onData);
      stdout.off("resize", onResize);
      stdin.setRawMode?.(false);
      stdin.pause();
      erase();
      stdout.write("\x1b[?25h");
      outcome();
    };

    const onResize = (): void => {
      rendered = 0;
      draw();
    };

    const refilter = (): void => {
      const focused = matches[cursor];
      matches = filterItems(options.items, query);
      const retained = focused ? matches.findIndex((item) => item.id === focused.id) : -1;
      cursor = retained >= 0 ? retained : 0;
      offset = 0;
    };

    const onData = (chunk: Buffer): void => {
      let settled = false;
      let dirty = false;
      // A single read can carry several keys (held arrows, fast typing, paste),
      // so every key in the chunk is handled before the list is redrawn once.
      for (const key of parseKeys(chunk.toString("utf8"))) {
        if (settled) break;
        const size = viewportSize();
        if (key === "\x03" || (key === "\x1b" && !query)) {
          settled = true;
          finish(() => reject(new CancelledError()));
        } else if (key === "\x1b") {
          query = "";
          refilter();
          dirty = true;
        } else if (key === "\r" || key === "\n") {
          const chosen = matches[cursor];
          if (chosen) {
            settled = true;
            finish(() => {
              confirmation(options.confirmLabel, chosen);
              resolve(chosen);
            });
          }
        } else if (key === "\x1b[A" || key === "\x1bOA" || key === "\x10") {
          cursor = matches.length ? (cursor - 1 + matches.length) % matches.length : 0;
          dirty = true;
        } else if (key === "\x1b[B" || key === "\x1bOB" || key === "\x0e" || key === "\t") {
          cursor = matches.length ? (cursor + 1) % matches.length : 0;
          dirty = true;
        } else if (key === "\x1b[5~") {
          cursor = Math.max(0, cursor - size);
          dirty = true;
        } else if (key === "\x1b[6~") {
          cursor = Math.min(Math.max(0, matches.length - 1), cursor + size);
          dirty = true;
        } else if (key === "\x1b[H" || key === "\x1bOH") {
          cursor = 0;
          dirty = true;
        } else if (key === "\x1b[F" || key === "\x1bOF") {
          cursor = Math.max(0, matches.length - 1);
          dirty = true;
        } else if (key === "\x7f" || key === "\b") {
          query = [...query].slice(0, -1).join("");
          refilter();
          dirty = true;
        } else if (key === "\x15") {
          query = "";
          refilter();
          dirty = true;
        } else if (!key.startsWith("\x1b") && key >= " " && key !== "\x7f") {
          query += key;
          refilter();
          dirty = true;
        }
      }
      if (!settled && dirty) draw();
    };

    stdout.on("resize", onResize);
    stdin.on("data", onData);
  });
}

/** Numbered fallback for pipes, CI, and terminals without raw mode. */
async function lineSelect<T extends SelectItem>(options: SelectOptions<T>): Promise<T> {
  let query = "";
  let page = 0;
  const pageSize = 12;
  while (true) {
    const matches = filterItems(options.items, query);
    const pages = Math.max(1, Math.ceil(matches.length / pageSize));
    page = Math.max(0, Math.min(page, pages - 1));
    const visible = matches.slice(page * pageSize, (page + 1) * pageSize);
    write();
    write(`${options.title}${query ? ` matching “${query}”` : ""} · ${matches.length} of ${options.items.length} · page ${page + 1}/${pages}`);
    write();
    visible.forEach((item, index) => {
      write(`  ${index + 1}. ${item.label}${item.badge && item.badge !== item.label ? ` (${item.badge})` : ""}`);
      if (item.description) write(`     ${item.description}`);
    });
    if (!visible.length) write(`  ${options.emptyMessage ?? "No matches."}`);
    write();
    write("  Enter a number · /search terms · n next · p previous · a show all · q cancel");
    const answer = (await ask("  › ")).trim();
    const command = answer.toLocaleLowerCase();
    if (command === "q") throw new CancelledError();
    if (command === "n") { page += 1; continue; }
    if (command === "p") { page -= 1; continue; }
    if (command === "a") { query = ""; page = 0; continue; }
    if (answer.startsWith("/")) { query = answer.slice(1).trim(); page = 0; continue; }
    const selected = visible[Number(answer) - 1];
    if (selected) {
      confirmation(options.confirmLabel, selected);
      return selected;
    }
    write("  Please enter one of the displayed numbers or commands.");
  }
}

async function ask(message: string, signal?: AbortSignal): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return await readline.question(message, { signal });
  } finally {
    readline.close();
  }
}

export interface TextOptions {
  label: string;
  placeholder?: string;
  hint?: string;
  allowEmpty?: boolean;
  signal?: AbortSignal;
  validate?: (value: string) => string | undefined;
}

/** Single-line input with a styled prompt and inline validation. */
export async function text(options: TextOptions): Promise<string> {
  if (options.hint) hint(options.hint);
  const suffix = options.placeholder ? style.faint(` ${options.placeholder}`) : "";
  const prompt = `  ${style.accent("❯")} ${options.label}${suffix} `;
  while (true) {
    const value = (await ask(prompt, options.signal)).trim();
    if (!value && !options.allowEmpty && !options.validate) continue;
    const problem = options.validate?.(value);
    if (problem) {
      fail(problem);
      continue;
    }
    return value;
  }
}

/**
 * Masked credential input. An empty submission is rejected rather than stored,
 * because a blank credential authenticates nothing but still looks configured.
 */
export async function secret(label: string, signal?: AbortSignal): Promise<string> {
  while (true) {
    const value = await readMasked(label, signal);
    if (value) return value;
    warn("Nothing was entered. Paste the value, or press Ctrl-C to cancel.");
  }
}

async function readMasked(label: string, signal?: AbortSignal): Promise<string> {
  const prompt = `  ${style.accent("❯")} ${label} ${style.faint("(hidden)")} `;
  if (!interactive) return (await ask(prompt, signal)).trim();
  signal?.throwIfAborted();
  stdout.write(prompt);
  stdin.setRawMode?.(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.off("data", onData);
      signal?.removeEventListener("abort", onAbort);
      stdout.write("\n");
    };
    const onAbort = (): void => {
      cleanup();
      reject(new CancelledError("Credential entry cancelled."));
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          return reject(new CancelledError("Credential entry cancelled."));
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          return resolve(value.trim());
        }
        if (byte === 127 || byte === 8) {
          if (value) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
        } else if (byte >= 32) {
          value += String.fromCharCode(byte);
          stdout.write(colorEnabled ? style.accent("•") : "•");
        }
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stdin.on("data", onData);
  });
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
  const choices = style.faint(fallback ? "[Y/n]" : "[y/N]");
  const answer = (await ask(`  ${style.accent("❯")} ${question} ${choices} `)).trim().toLocaleLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

/** Regional-indicator flag for an ISO 3166-1 alpha-2 code, blank when unusable. */
export function flag(countryCode: string): string {
  if (!/^[A-Za-z]{2}$/.test(countryCode)) return "";
  return String.fromCodePoint(
    ...[...countryCode.toUpperCase()].map((character) => 0x1f1e6 + character.charCodeAt(0) - 65),
  );
}
