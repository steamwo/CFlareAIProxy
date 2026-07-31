/**
 * Frontend/backend type drift check.
 *
 * `src/types.ts` and `web/src/types.ts` are two independently hand-written descriptions of
 * the same JSON. Nothing links them, so a backend field added or removed is only caught by
 * whoever remembers to edit the console. This compares the *field names* of the pairs
 * declared in `type-contract.mjs` and fails on any difference the contract does not
 * explain.
 *
 * Design constraints, in order of importance:
 *
 * 1. Immune to refactors. Declarations are located by parsing the TypeScript AST and
 *    looking up *exported declared names* across the whole tree — never by file path,
 *    line number or source-text matching. Renaming a file, moving a declaration to a new
 *    module, reordering fields, reformatting, or adding comments/JSDoc cannot change the
 *    result. `interface X extends Y` and `type X = { ... }` both resolve, so converting
 *    between those forms is also free.
 * 2. Fails only on real drift. Only the set of property names is compared. Declared types,
 *    optionality and ordering are deliberately ignored, because the two sides legitimately
 *    model the same wire field differently (`endpoint` is a union on the Worker and a
 *    plain `string` in the console) — comparing them would fire on correct code.
 * 3. Actionable failures. Every message names the pair, the exact field, and the direction.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";
import { TYPE_CONTRACT } from "./type-contract.mjs";

const SOURCE_EXTENSIONS = new Set([".ts", ".vue"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", ".wrangler", ".git"]);

function listSourceFiles(directory, collected = []) {
  for (const entry of readdirSync(directory)) {
    if (IGNORED_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      listSourceFiles(path, collected);
      continue;
    }
    // Tests may declare fixture-shaped locals; they are not part of the wire contract.
    if (SOURCE_EXTENSIONS.has(extname(path)) && !path.endsWith(".test.ts")) collected.push(path);
  }
  return collected;
}

/**
 * Vue SFCs can host shared declarations, so their script blocks are parsed too. Offsets are
 * irrelevant here because only declared names and member names are read.
 */
function extractTypeScript(path) {
  const text = readFileSync(path, "utf8");
  if (extname(path) !== ".vue") return text;
  const blocks = [];
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let match = pattern.exec(text);
  while (match) {
    blocks.push(match[1] ?? "");
    match = pattern.exec(text);
  }
  return blocks.join("\n");
}

function isExported(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function propertyNames(members) {
  const names = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
    const name = member.name;
    // Computed keys carry no statically comparable field name; skip rather than guess.
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) names.push(name.text);
  }
  return names;
}

/**
 * Index every exported interface / object-type alias / union alias in a tree, keyed by its
 * declared name. Only exported declarations are indexed: a wire type shared between modules
 * must be exported, and ignoring file-local helpers keeps an unrelated local `interface
 * Provider` in some view from colliding with the contract.
 */
function indexDeclarations(treeRoot, repoRoot) {
  const declarations = new Map();
  const record = (name, entry) => {
    const existing = declarations.get(name) ?? [];
    existing.push(entry);
    declarations.set(name, existing);
  };

  for (const path of listSourceFiles(treeRoot)) {
    const file = ts.createSourceFile(path, extractTypeScript(path), ts.ScriptTarget.Latest, true);
    const location = relative(repoRoot, path).replaceAll("\\", "/");
    const visit = (node) => {
      if (ts.isInterfaceDeclaration(node) && isExported(node)) {
        record(node.name.text, {
          location,
          kind: "object",
          members: propertyNames(node.members),
          heritage: (node.heritageClauses ?? []).flatMap((clause) =>
            clause.token === ts.SyntaxKind.ExtendsKeyword
              ? clause.types.filter((type) => ts.isIdentifier(type.expression)).map((type) => type.expression.text)
              : [],
          ),
        });
      } else if (ts.isTypeAliasDeclaration(node) && isExported(node)) {
        if (ts.isTypeLiteralNode(node.type)) {
          record(node.name.text, { location, kind: "object", members: propertyNames(node.type.members), heritage: [] });
        } else if (ts.isUnionTypeNode(node.type)) {
          const literals = node.type.types
            .filter((type) => ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal))
            .map((type) => type.literal.text);
          if (literals.length === node.type.types.length) {
            record(node.name.text, { location, kind: "union", members: literals, heritage: [] });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return declarations;
}

/** Resolve a name to a single declaration, reporting ambiguity and absence distinctly. */
function resolve(declarations, name, treeLabel, errors, context) {
  const found = declarations.get(name);
  if (!found || found.length === 0) {
    errors.push(`${context}：在 ${treeLabel} 中找不到导出的类型 ${name}（重命名后请同步更新 scripts/type-contract.mjs）`);
    return undefined;
  }
  if (found.length > 1) {
    errors.push(`${context}：${treeLabel} 中有多个导出的 ${name}（${found.map((entry) => entry.location).join("、")}），无法确定比对目标`);
    return undefined;
  }
  return found[0];
}

/**
 * Flatten `extends` chains so splitting a shared base out of an interface stays a refactor.
 * Bases outside the tree (or not exported) contribute nothing and are silently skipped —
 * the contract only describes fields both sides declare locally.
 */
function flattenMembers(declarations, entry, seen = new Set()) {
  const members = new Set(entry.members);
  for (const base of entry.heritage) {
    if (seen.has(base)) continue;
    seen.add(base);
    const resolved = declarations.get(base);
    if (resolved?.length === 1 && resolved[0]) {
      for (const member of flattenMembers(declarations, resolved[0], seen)) members.add(member);
    }
  }
  return members;
}

function checkAllowlist(allowed, actual, pairLabel, direction, errors) {
  for (const [field, reason] of Object.entries(allowed)) {
    if (actual.has(field)) continue;
    errors.push(
      `${pairLabel}：契约声明字段 ${field} 仅存在于${direction}（${reason}），但实际已不是——请从 scripts/type-contract.mjs 中删除该条目`,
    );
  }
}

export function checkTypeContract(repoRoot) {
  const errors = [];
  const backend = indexDeclarations(join(repoRoot, "src"), repoRoot);
  const frontend = indexDeclarations(join(repoRoot, "web", "src"), repoRoot);

  for (const pair of TYPE_CONTRACT.interfaces) {
    const label = `类型漂移 ${pair.backend} ↔ ${pair.frontend}（${pair.note}）`;
    const backendEntry = resolve(backend, pair.backend, "src/**", errors, label);
    const frontendEntry = resolve(frontend, pair.frontend, "web/src/**", errors, label);
    if (!backendEntry || !frontendEntry) continue;
    if (backendEntry.kind !== "object" || frontendEntry.kind !== "object") {
      errors.push(`${label}：契约期望对象类型，但解析结果不是`);
      continue;
    }

    const backendFields = flattenMembers(backend, backendEntry);
    const frontendFields = flattenMembers(frontend, frontendEntry);
    const backendOnly = new Set([...backendFields].filter((field) => !frontendFields.has(field)));
    const frontendOnly = new Set([...frontendFields].filter((field) => !backendFields.has(field)));

    for (const field of backendOnly) {
      if (field in pair.backendOnly) continue;
      errors.push(
        `${label}：后端 ${pair.backend} 有字段 ${field}，前端 ${pair.frontend} 没有。` +
          `请在 ${frontendEntry.location} 补上该字段，或在 scripts/type-contract.mjs 的 backendOnly 中说明它为何不下发`,
      );
    }
    for (const field of frontendOnly) {
      if (field in pair.frontendOnly) continue;
      errors.push(
        `${label}：前端 ${pair.frontend} 有字段 ${field}，后端 ${pair.backend} 没有。` +
          `请确认该字段仍由处理器附加，或从 ${frontendEntry.location} 删除，或在 scripts/type-contract.mjs 的 frontendOnly 中说明来源`,
      );
    }
    checkAllowlist(pair.backendOnly, backendOnly, label, "后端", errors);
    checkAllowlist(pair.frontendOnly, frontendOnly, label, "前端", errors);
  }

  for (const pair of TYPE_CONTRACT.unions) {
    const label = `类型漂移 ${pair.backend} ↔ ${pair.frontend}（${pair.note}）`;
    const backendEntry = resolve(backend, pair.backend, "src/**", errors, label);
    const frontendEntry = resolve(frontend, pair.frontend, "web/src/**", errors, label);
    if (!backendEntry || !frontendEntry) continue;
    if (backendEntry.kind !== "union" || frontendEntry.kind !== "union") {
      errors.push(`${label}：契约期望字符串字面量联合类型，但解析结果不是`);
      continue;
    }
    const backendMembers = new Set(backendEntry.members);
    const frontendMembers = new Set(frontendEntry.members);
    for (const member of backendMembers) {
      if (frontendMembers.has(member)) continue;
      errors.push(`${label}：后端有取值 "${member}"，前端 ${frontendEntry.location} 缺失`);
    }
    for (const member of frontendMembers) {
      if (backendMembers.has(member)) continue;
      errors.push(`${label}：前端有取值 "${member}"，后端已不再支持`);
    }
  }

  return errors;
}
