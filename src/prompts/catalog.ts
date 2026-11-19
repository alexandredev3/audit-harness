import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const ORDINARY_FILE = "ATTACK-CLASSES.md";
const COMPANION_SECTIONS = ["Core discipline", "Universal moves", "Validation rules"];

export interface Block {
  ref: string;
  file: string;
  name: string;
  kind: "class" | "section";
  text: string;
}

export interface CatalogFile {
  file: string;
  ordinary: boolean;
  whenToUse: string;
  classRefs: string[];
}

export interface Catalog {
  blocks: Map<string, Block>;
  files: CatalogFile[];
}

const CLASS_HEADER = /^\*\*(.+?)\*\*(?:\s+\(subagent_type:[^)]*\))?\s*$/;
const SECTION_HEADER = /^## (.+?)(?:\s+\(.*\))?\s*$/;
const WHEN_TO_USE = /^#### When to use this file\s*$/;

export function parseClassFile(file: string, text: string): { blocks: Block[]; whenToUse: string } {
  const blocks: Block[] = [];
  const whenLines: string[] = [];
  let current: { name: string; kind: Block["kind"]; lines: string[] } | null = null;
  let inWhen = false;

  const flush = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    blocks.push({ ref: `${file}#${current.name}`, file, name: current.name, kind: current.kind, text: body });
    current = null;
  };

  for (const line of text.split("\n")) {
    const section = SECTION_HEADER.exec(line);
    if (section) {
      flush();
      inWhen = false;
      const name = section[1] ?? "";
      if (COMPANION_SECTIONS.includes(name)) {
        current = { name, kind: "section", lines: [line] };
      }
      continue;
    }
    if (WHEN_TO_USE.test(line)) {
      flush();
      inWhen = true;
      continue;
    }
    const cls = CLASS_HEADER.exec(line);
    if (cls) {
      flush();
      inWhen = false;
      current = { name: cls[1] ?? "", kind: "class", lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
    else if (inWhen) whenLines.push(line);
  }
  flush();
  return { blocks, whenToUse: whenLines.join("\n").trim() };
}

export function loadCatalog(dir: string): Catalog {
  const blocks = new Map<string, Block>();
  const files: CatalogFile[] = [];
  const names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  for (const file of names) {
    const parsed = parseClassFile(file, readFileSync(join(dir, file), "utf8"));
    const classRefs: string[] = [];
    for (const block of parsed.blocks) {
      if (!block.text) throw new Error(`empty block ${block.ref}`);
      if (blocks.has(block.ref)) throw new Error(`duplicate block reference ${block.ref}`);
      blocks.set(block.ref, block);
      if (block.kind === "class") classRefs.push(block.ref);
    }
    if (classRefs.length === 0) throw new Error(`${file} defines no attack class`);
    files.push({ file, ordinary: file === ORDINARY_FILE, whenToUse: parsed.whenToUse, classRefs });
  }
  if (!files.some((f) => f.ordinary)) throw new Error(`${ORDINARY_FILE} is missing from ${dir}`);
  return { blocks, files };
}

export function isClassRef(catalog: Catalog, ref: string): boolean {
  return catalog.blocks.get(ref)?.kind === "class";
}

export function isOrdinaryRef(ref: string): boolean {
  return ref.startsWith(`${ORDINARY_FILE}#`);
}

export function companionBlocksFor(catalog: Catalog, classRef: string): string[] {
  const file = classRef.slice(0, classRef.indexOf("#"));
  const sections = COMPANION_SECTIONS.map((s) => `${file}#${s}`).filter((ref) => catalog.blocks.has(ref));
  return [classRef, ...sections];
}

export function catalogSummary(catalog: Catalog): string {
  const out: string[] = [];
  for (const f of catalog.files) {
    out.push(`### ${f.file}${f.ordinary ? " (ordinary classes, apply to most targets)" : " (companion)"}`);
    if (f.whenToUse) out.push(`When to use: ${f.whenToUse.split("\n")[0]}`);
    for (const ref of f.classRefs) out.push(`- ${ref}`);
    out.push("");
  }
  return out.join("\n");
}
