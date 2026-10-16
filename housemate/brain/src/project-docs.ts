import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * The owner's projects folder, for the assistant to study before he answers ("the assistant
 * should be able to look in the projects folder and see what is there"). Read-only, text only:
 * Markdown and plain-text notes under the root, never hidden folders, backups or dependencies, and
 * never a line that looks like it holds a secret. The chat tools (list_projects, search_projects,
 * read_project_file) are its only callers; the model sees passages, never paths outside the root.
 */

export const PROJECT_DOCS_LIMITS = Object.freeze({
  /** A file larger than this is skipped: it is data, not notes. */
  fileBytes: 1_000_000,
  files: 2_000,
  passageChars: 900,
  passages: 6,
  readChars: 6_000,
  summaryChars: 280,
});

const TEXT_FILE = /\.(?:md|markdown|txt)$/iu;
const SKIPPED_DIR = /^(?:\.|node_modules$|backups?$|archive$|dist$|build$|inputs$|captures$|__pycache__$)/iu;
const SECRET_LINE = /\b(?:token|password|passwd|secret|api[_ -]?key|private[_ -]?key|bearer)\b\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[A-Za-z0-9_-]{40,}\b/u;

interface ProjectDoc {
  /** Path under the root, with forward slashes. */
  readonly path: string;
  readonly project: string;
  readonly text: string;
}

interface Passage {
  readonly doc: ProjectDoc;
  readonly heading: string;
  readonly text: string;
}

export class ProjectDocs {
  private readonly root: string;
  private docs: readonly ProjectDoc[] = [];
  private scannedAt = 0;

  constructor(root: string, private readonly now: () => number = Date.now) {
    this.root = resolve(root);
  }

  /** Every project: its folder or note, its title and the first lines that say what it is. */
  list(): string {
    const docs = this.scan();
    if (docs.length === 0) return "No projects found.";
    const byProject = new Map<string, ProjectDoc[]>();
    for (const doc of docs) byProject.set(doc.project, [...(byProject.get(doc.project) ?? []), doc]);
    return [...byProject.entries()].map(([project, files]) => {
      const lead = files.find((doc) => /(?:^|\/)readme\.md$/iu.test(doc.path)) ?? files[0];
      const title = /^#\s+(.+)$/mu.exec(lead?.text ?? "")?.[1]?.trim() ?? project;
      const summary = firstParagraph(lead?.text ?? "");
      return `- ${project} (${files.length} note${files.length === 1 ? "" : "s"}): ${title}${summary ? `: ${summary}` : ""}`;
    }).join("\n");
  }

  /** The passages that best match the words, best first, each with where it came from. */
  search(query: string, project: string | null): string {
    const words = searchWords(query);
    if (words.length === 0) return "Say what to look for.";
    const scored: { readonly passage: Passage; readonly score: number }[] = [];
    for (const doc of this.scan()) {
      if (project && doc.project.toLowerCase() !== project.toLowerCase()) continue;
      for (const passage of passages(doc)) {
        const haystack = `${passage.heading} ${passage.text}`.toLowerCase();
        let score = 0;
        for (const word of words) {
          const hits = haystack.split(word).length - 1;
          if (hits > 0) score += 1 + Math.log(hits);
        }
        if (score > 0) scored.push({ passage, score: score * (passage.heading.toLowerCase().includes(words[0] ?? "") ? 1.3 : 1) });
      }
    }
    if (scored.length === 0) return "Nothing in the projects matches that.";
    return scored
      .sort((left, right) => right.score - left.score)
      .slice(0, PROJECT_DOCS_LIMITS.passages)
      .map(({ passage }) => `[${passage.doc.path}${passage.heading ? ` > ${passage.heading}` : ""}]\n${cap(passage.text, PROJECT_DOCS_LIMITS.passageChars)}`)
      .join("\n\n");
  }

  /** One note, from its start, as far as the limit. */
  read(path: string): string {
    const wanted = path.replaceAll("\\", "/").replace(/^\/+/u, "");
    const doc = this.scan().find((item) => item.path === wanted);
    return doc ? cap(doc.text, PROJECT_DOCS_LIMITS.readChars) : "No such note in the projects.";
  }

  private scan(): readonly ProjectDoc[] {
    // The folder changes rarely; a minute's cache keeps a chat's several calls to one walk.
    if (this.now() - this.scannedAt < 60_000) return this.docs;
    const docs: ProjectDoc[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (docs.length >= PROJECT_DOCS_LIMITS.files) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIR.test(entry.name)) walk(full);
          continue;
        }
        if (!entry.isFile() || !TEXT_FILE.test(entry.name)) continue;
        try {
          const stat = statSync(full);
          if (stat.size > PROJECT_DOCS_LIMITS.fileBytes) continue;
          const path = relative(this.root, full).split(sep).join("/");
          docs.push({
            path,
            project: path.includes("/") ? path.slice(0, path.indexOf("/")) : path.replace(TEXT_FILE, ""),
            text: withoutSecrets(readFileSync(full, "utf8")),
          });
        } catch {
          continue;
        }
      }
    };
    walk(this.root);
    this.docs = docs.sort((left, right) => left.path.localeCompare(right.path));
    this.scannedAt = this.now();
    return this.docs;
  }
}

function withoutSecrets(text: string): string {
  return text.split("\n").map((line) => (SECRET_LINE.test(line) ? "[withheld]" : line)).join("\n");
}

/** A note cut at its headings, and long sections at blank lines. */
function passages(doc: ProjectDoc): readonly Passage[] {
  const out: Passage[] = [];
  let heading = "";
  let body: string[] = [];
  const flush = (): void => {
    const text = body.join("\n").trim();
    if (text) {
      for (const piece of chunks(text, PROJECT_DOCS_LIMITS.passageChars)) out.push({ doc, heading, text: piece });
    }
    body = [];
  };
  for (const line of doc.text.split("\n")) {
    const match = /^#{1,6}\s+(.+)$/u.exec(line);
    if (match) {
      flush();
      heading = match[1]?.trim() ?? "";
    } else {
      body.push(line);
    }
  }
  flush();
  return out;
}

function chunks(text: string, size: number): readonly string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\s*\n/u)) {
    if (current && current.length + paragraph.length > size) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) out.push(current);
  return out;
}

function firstParagraph(text: string): string {
  const body = text.split("\n").filter((line) => !/^#/u.test(line)).join("\n").trim();
  return cap(body.split(/\n\s*\n/u)[0]?.replace(/\s+/gu, " ").trim() ?? "", PROJECT_DOCS_LIMITS.summaryChars);
}

function searchWords(query: string): readonly string[] {
  const stop = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "what", "about", "project", "projects", "my", "his", "with"]);
  return [...new Set(query.toLowerCase().replace(/[^a-z0-9 ]+/gu, " ").split(/\s+/u).filter((word) => word.length > 1 && !stop.has(word)))];
}

function cap(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars).trimEnd()}…`;
}

const nameCache = new Map<string, { readonly at: number; readonly names: readonly string[] }>();

/**
 * The names the owner's projects go by, from their folder or note names and their titles: "garden
 * sensors", "water meter", "recipe book". Exact whole names only, never a fuzzy
 * match; cached a minute per folder.
 */
export function projectNames(root: string, now: number = Date.now()): readonly string[] {
  const cached = nameCache.get(root);
  if (cached && now - cached.at < 60_000) return cached.names;
  const names = new Set<string>();
  const add = (raw: string): void => {
    const name = raw.toLowerCase().replace(TEXT_FILE, "").replace(/[-_]+/gu, " ").replace(/[^a-z0-9 ]+/gu, " ").replace(/\s+/gu, " ").trim();
    // Whole names only: "Project-Language" is not "language".
    if (name.length >= 4) names.add(name);
  };
  let entries: Dirent[] = [];
  if (!root.trim()) return [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    // No folder: no names.
  }
  for (const entry of entries) {
    if (SKIPPED_DIR.test(entry.name)) continue;
    if (entry.isDirectory()) {
      add(entry.name);
      try {
        const title = /^#\s+(.+)$/mu.exec(readFileSync(join(root, entry.name, "README.md"), "utf8"))?.[1];
        if (title) add(title);
      } catch {
        // A project without a README goes by its folder name.
      }
    } else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
      add(entry.name);
    }
  }
  const list = [...names];
  nameCache.set(root, { at: now, names: list });
  return list;
}

/** Whether the words name one of the owner's projects, as a whole phrase. */
export function namesProject(normalized: string, root: string): boolean {
  const text = ` ${normalized.toLowerCase().replace(/[^a-z0-9 ]+/gu, " ").replace(/\s+/gu, " ")} `;
  return projectNames(root).some((name) => text.includes(` ${name} `));
}
