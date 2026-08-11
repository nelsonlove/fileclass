/*
 * Binding resolver (ARCHITECTURE.md §10). Pure — decides which fileClass(es)
 * bind to a note and merges their fields, following Metadata Menu's priority:
 *
 *   frontmatter alias > tag > path > bookmark group > (base-view) > global > preset
 *
 * Base-view match (which replaces MDM's dataview `fileClassQueries`) needs the
 * Bases adapter and is wired in a later phase; the resolver exposes it as an
 * optional pre-resolved input (`baseViewNames`) so this module stays pure.
 */
import { Field } from "./field";

export interface FileBinding {
	/** fileClass names from the note's frontmatter alias (inner binding). */
	innerNames: string[];
	/** Tags on the note, without the leading "#". */
	tags: string[];
	/** Folder (parent) path of the note. */
	folderPath: string;
	/** Bookmark group paths containing the note (optional). */
	bookmarkGroups?: string[];
	/** fileClass names matched by a base view (optional, resolved upstream). */
	baseViewNames?: string[];
}

export interface FileClassRegistry {
	has(name: string): boolean;
	fieldsOf(name: string): Field[];
	/** tag → fileClass name (from `mapWithTag` / `tagNames`). */
	tagBindings: ReadonlyMap<string, string>;
	/** folder-path prefix → fileClass name (from `filesPaths`). */
	pathBindings: ReadonlyMap<string, string>;
	/** bookmark group → fileClass name (from `bookmarksGroups`). */
	bookmarkBindings: ReadonlyMap<string, string>;
	globalFileClass?: string;
	presetFields?: Field[];
}

export type BindingSource = "fileClass" | "global" | "preset" | "none";

export interface Resolution {
	/** Ordered, de-duplicated bound fileClass names (empty for global/preset). */
	fileClassNames: string[];
	/** Fields merged in priority order, de-duplicated by id. */
	fields: Field[];
	source: BindingSource;
}

/**
 * A note tag and the tags it is nested under, most specific first:
 * `author/french/poetry` → `author/french/poetry`, `author/french`, `author`.
 *
 * Obsidian treats nested tags as a hierarchy everywhere else — tag search and the
 * tag pane include children — and so does Bases: `file.hasTag("author")` matches
 * `#author/french`. A class mapped on `author` therefore claims `#author/french`
 * too, which is what makes a generated view and the binding agree.
 */
export function tagAncestry(tag: string): string[] {
	const parts = tag.split("/").filter(Boolean);
	return parts.map((_, i) => parts.slice(0, parts.length - i).join("/"));
}

/** Bound fileClass names in priority order, keeping only those in the registry. */
function collectBoundNames(binding: FileBinding, registry: FileClassRegistry): string[] {
	const names: string[] = [];
	const add = (name: string | undefined) => {
		if (name && registry.has(name) && !names.includes(name)) names.push(name);
	};

	// 1. inner (frontmatter alias)
	binding.innerNames.forEach(add);
	// 2. tag match, a nested tag counting as its ancestors
	for (const tag of binding.tags) {
		for (const candidate of tagAncestry(tag)) add(registry.tagBindings.get(candidate));
	}
	// 3. path match (folder path is under a mapped prefix)
	for (const [prefix, name] of registry.pathBindings) {
		if (binding.folderPath === prefix || binding.folderPath.startsWith(prefix)) add(name);
	}
	// 4. bookmark group match
	(binding.bookmarkGroups ?? []).forEach((group) => add(registry.bookmarkBindings.get(group)));
	// 5. base-view match (pre-resolved upstream)
	(binding.baseViewNames ?? []).forEach(add);

	return names;
}

/** Concatenates the fields of each bound class, de-duplicating by field id. */
function mergeFields(names: string[], registry: FileClassRegistry): Field[] {
	const fields: Field[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		for (const field of registry.fieldsOf(name)) {
			if (seen.has(field.id)) continue;
			fields.push(field);
			seen.add(field.id);
		}
	}
	return fields;
}

/**
 * Resolves a note's binding. Falls back to the global fileClass, then to preset
 * fields, then to nothing — exactly as Metadata Menu's `getFilesFields`.
 */
export function resolveBinding(binding: FileBinding, registry: FileClassRegistry): Resolution {
	const names = collectBoundNames(binding, registry);
	if (names.length) {
		return { fileClassNames: names, fields: mergeFields(names, registry), source: "fileClass" };
	}
	const global = registry.globalFileClass;
	if (global && registry.has(global)) {
		return { fileClassNames: [global], fields: registry.fieldsOf(global), source: "global" };
	}
	if (registry.presetFields?.length) {
		return { fileClassNames: [], fields: registry.presetFields, source: "preset" };
	}
	return { fileClassNames: [], fields: [], source: "none" };
}

/**
 * Resolves a note's inner fileClass names from its frontmatter LINKS
 * (wikilink-only alias binding, ARCHITECTURE.md §10). Pure: `resolvePath`
 * injects Obsidian's `getFirstLinkpathDest(...).path`, `nameByPath` the index's
 * path→name map. Handles a scalar alias (`key === alias`) and list items
 * (`key === alias.<n>`), keeps order, drops unresolved / non-fileClass links,
 * and de-duplicates.
 */
export function resolveInnerFileClassNames(
	links: readonly { key: string; link: string }[],
	alias: string,
	resolvePath: (link: string) => string | null,
	nameByPath: ReadonlyMap<string, string>
): string[] {
	const out: string[] = [];
	for (const l of links) {
		if (l.key !== alias && !l.key.startsWith(`${alias}.`)) continue;
		const path = resolvePath(l.link);
		if (!path) continue;
		const name = nameByPath.get(path);
		if (name && !out.includes(name)) out.push(name);
	}
	return out;
}

/**
 * Resolves a fileClass's `extends` value to a canonical registry name. Accepts a
 * wikilink (`"[[Note.fileclass]]"`, resolved folder-independently via
 * `resolveLinkToName`) or a bare name — matched as given, else with the
 * `.fileclass` suffix appended (forgiving of the display-style name). Returns
 * undefined when no parent resolves.
 */
export function resolveExtendsName(
	raw: string | undefined,
	resolveLinkToName: (link: string) => string | undefined,
	hasName: (name: string) => boolean
): string | undefined {
	if (!raw) return undefined;
	const link = raw.match(/^\[\[(.+?)\]\]$/);
	if (link) {
		// Strip a `#subpath` and `|alias` — getFirstLinkpathDest wants the bare linkpath.
		const linkpath = link[1].split("|")[0].split("#")[0].trim();
		return resolveLinkToName(linkpath);
	}
	if (hasName(raw)) return raw;
	const suffixed = `${raw}.fileclass`;
	return hasName(suffixed) ? suffixed : undefined;
}

/**
 * Resolves the **Global fileClass** setting to a canonical registry name.
 *
 * Accepts everything `extends` accepts — and for the same reason: this fork made
 * `[[Name.fileclass]]` the way a class is referred to everywhere else, so that is
 * the form a user naturally types here too. Delegating to `resolveExtendsName`
 * rather than re-implementing the match is what keeps the two from drifting; the
 * earlier version of this resolver handled bare names, suffixed names and paths but
 * not wikilinks, so a setting of `"[[Default.fileclass]]"` silently resolved to
 * nothing and the global binding never fired.
 *
 * On top of those, one form only this setting can carry: a **path**, from when it
 * held a `classFilesPath`-style value. Matched on the filename, `.md` tolerated.
 */
export function resolveGlobalFileClassName(
	raw: string | undefined,
	resolveLinkToName: (link: string) => string | undefined,
	hasName: (name: string) => boolean
): string | undefined {
	const value = raw?.trim();
	if (!value) return undefined;

	const direct = resolveExtendsName(value, resolveLinkToName, hasName);
	if (direct) return direct;

	const base = (value.split("/").pop() ?? value).replace(/\.md$/, "");
	if (base === value) return undefined; // already tried above
	for (const candidate of [base, `${base}.fileclass`]) {
		if (hasName(candidate)) return candidate;
	}
	return undefined;
}
