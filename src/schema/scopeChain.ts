/*
 * Scope chains for scoped fileClasses (ARCHITECTURE.md §10.3). Pure — every read of the vault
 * goes through a `ScopeHost`, so the walk is pinned by unit tests rather than by trial in the app.
 *
 * A **scope note** is a folder note (file name equals its folder's name) whose class is the scope
 * class or a class that extends it. A note's scope is the nearest folder, from its own upward, that
 * holds a scope note. From a scope note the chain follows one configurable link key (`up` by
 * default) to its parent scope, then that one's parent, and so on. A class name a note carries is
 * looked up in its scope's classes, then the parent's, and so on, the root's last.
 *
 * Nothing here decides which class a note *has* — binding is the resolver's (resolver.ts). This
 * module only says which classes folders a note can see, and in what order.
 */

/** How deep a chain may go before the walk gives up. A real vault has three or four levels. */
export const MAX_CHAIN_DEPTH = 16;

/** The class a file in a scoped classes folder must carry to count as a class. */
export const SCOPED_CLASS_TYPE = "Meta/Fileclass";

/** The frontmatter key a note may use to name its scope instead of its folder. */
export const NOTE_SCOPE_KEY = "scope";

/** What the walk needs to know about the vault. The index implements it on the metadata cache. */
export interface ScopeHost {
	/** Frontmatter of a Markdown file, or undefined when there is no such file or none. */
	frontmatterOf(path: string): Record<string, unknown> | undefined;
	/** True when a Markdown file exists at `path`. */
	isFile(path: string): boolean;
	/** True when a folder exists at `path` ("" is the vault root). */
	isFolder(path: string): boolean;
	/** Names of the direct child folders of `path`. */
	childFolders(path: string): string[];
	/** The file a link points at, from `sourcePath` (Obsidian's `getFirstLinkpathDest`). */
	resolveLink(linkpath: string, sourcePath: string): string | undefined;
	/** True when a class name is the scope class or extends it. */
	isScopeClass(name: string): boolean;
}

export interface ScopeSettings {
	/** Frontmatter key binding a note to its class(es) (`fileClassAlias`). */
	typeKey: string;
	/** The link key a scope note names its parent scope with (`scopeParentKey`). */
	parentKey: string;
	/** The key a scope note may name its own classes folder(s) with (`scopedClassesKey`). */
	classesKey: string;
	/** Where a scope keeps its classes, below its folder (`scopedClassesPattern`). */
	pattern: string;
}

// -- paths ---------------------------------------------------------------------

/** `a/b/`, `/a/b`, `a/b` → `a/b`; the vault root → "". */
export function normaliseFolder(path: string): string {
	return path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Parent folder of a path ("" at the top). */
export function parentFolder(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

function baseName(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? path : path.slice(i + 1);
}

/** The folder note a folder would hold: `A/B` → `A/B/B.md`. The vault root has none. */
export function folderNotePath(folder: string): string | undefined {
	const f = normaliseFolder(folder);
	return f ? `${f}/${baseName(f)}.md` : undefined;
}

/** True when `path` is the folder note of the folder it sits in. */
export function isFolderNote(path: string): boolean {
	if (!path.endsWith(".md")) return false;
	const folder = parentFolder(path);
	return !!folder && baseName(path).slice(0, -".md".length) === baseName(folder);
}

/** The class names a frontmatter value names (a string, a list, or a comma list). */
export function classNamesOf(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((v) => v != null).map((v) => String(v).trim());
	if (typeof value === "string" && value.trim()) return value.split(",").map((v) => v.trim());
	return [];
}

/** `[[A/B|alias]]`, `[[A/B#h]]`, `"A/B"` → `A/B`; anything else → undefined. */
export function linkTarget(value: unknown): string | undefined {
	const raw: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
	if (typeof raw !== "string") return undefined;
	const m = raw.trim().match(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/);
	const target = (m ? m[1] : raw).trim();
	return target || undefined;
}

// -- scope notes ----------------------------------------------------------------

/** True when the note carries the scope class or a class that extends it. */
export function hasScopeClass(path: string, host: ScopeHost, settings: ScopeSettings): boolean {
	const fm = host.frontmatterOf(path);
	if (!fm) return false;
	return classNamesOf(fm[settings.typeKey]).some((name) => host.isScopeClass(name));
}

/**
 * A scope note: a folder note with the scope class. One exception, for the root: a note with the
 * scope class at the top of the vault, which has no folder of its own to be the note of.
 */
export function isScopeNote(path: string, host: ScopeHost, settings: ScopeSettings): boolean {
	if (!host.isFile(path)) return false;
	if (!isFolderNote(path) && parentFolder(path) !== "") return false;
	return hasScopeClass(path, host, settings);
}

/**
 * The scope of a folder: the nearest folder, from this one upward, holding a scope note.
 * `undefined` means the root scope. `cache` maps folder → answer, and is filled on the way.
 */
export function scopeOfFolder(
	folder: string,
	host: ScopeHost,
	settings: ScopeSettings,
	cache?: Map<string, string | undefined>
): string | undefined {
	const visited: string[] = [];
	let current = normaliseFolder(folder);
	let found: string | undefined;
	for (;;) {
		if (cache?.has(current)) {
			found = cache.get(current);
			break;
		}
		visited.push(current);
		const note = folderNotePath(current);
		if (note && isScopeNote(note, host, settings)) {
			found = note;
			break;
		}
		if (current === "") break;
		current = parentFolder(current);
	}
	if (cache) for (const f of visited) cache.set(f, found);
	return found;
}

/**
 * The scope of one note: a `scope:` link to a scope note when it carries one, else its folder's.
 * Free text in `scope:` is common and means something else, so only a link that resolves to a scope
 * note counts; anything else falls back to the folder, silently.
 */
export function scopeOfNote(
	path: string,
	host: ScopeHost,
	settings: ScopeSettings,
	cache?: Map<string, string | undefined>
): string | undefined {
	const declared = host.frontmatterOf(path)?.[NOTE_SCOPE_KEY];
	if (typeof declared === "string" && declared.trim().startsWith("[[")) {
		const target = linkTarget(declared);
		const resolved = target ? host.resolveLink(target, path) : undefined;
		if (resolved && isScopeNote(resolved, host, settings)) return resolved;
	}
	return scopeOfFolder(parentFolder(path), host, settings, cache);
}

// -- the chain ------------------------------------------------------------------

export interface ChainResult {
	/** Scope notes from the given one upward, the given one first. Never includes the root folder. */
	chain: string[];
	/** Why the walk stopped early, when it did. */
	errors: string[];
}

/**
 * Walks `parentKey` from a scope note upward. Stops, and says why, on a link that does not
 * resolve, a target that is not a scope note, a cycle, or a chain deeper than `MAX_CHAIN_DEPTH`.
 * A note with no parent ends the walk quietly: that is the top. The root's classes folder is not
 * part of the chain — the index always appends it, so a gap is never fatal.
 */
export function chainOf(scopeNote: string, host: ScopeHost, settings: ScopeSettings): ChainResult {
	const chain: string[] = [scopeNote];
	const seen = new Set<string>([scopeNote]);
	const errors: string[] = [];
	let current = scopeNote;
	for (;;) {
		const value = host.frontmatterOf(current)?.[settings.parentKey];
		const target = linkTarget(value);
		if (!target) break;
		const parent = host.resolveLink(target, current);
		if (!parent) {
			errors.push(`Scope ${current}: ${settings.parentKey} "${target}" does not resolve; the chain stops there.`);
			break;
		}
		if (!isScopeNote(parent, host, settings)) {
			errors.push(`Scope ${current}: ${settings.parentKey} points at ${parent}, which is not a scope note; the chain stops there.`);
			break;
		}
		if (seen.has(parent)) {
			errors.push(`Scope ${current}: ${settings.parentKey} makes a cycle back to ${parent}; the chain stops there.`);
			break;
		}
		if (chain.length >= MAX_CHAIN_DEPTH) {
			errors.push(`Scope ${scopeNote}: the chain is deeper than ${MAX_CHAIN_DEPTH}; the walk stops at ${current}.`);
			break;
		}
		chain.push(parent);
		seen.add(parent);
		current = parent;
	}
	return { chain, errors };
}

// -- classes folders ------------------------------------------------------------

/**
 * Parses the classes-folder pattern: `/`-separated segments, each a regular expression a folder
 * **name** must match whole. `\d\d\.03 .*\/classes` means "a child named like `80.03 Shapes`, then
 * its `classes` child". A segment that is not a valid expression makes the whole pattern invalid.
 */
export function parsePattern(pattern: string): { segments: RegExp[]; error?: string } {
	const parts = pattern.split("/").map((p) => p.trim()).filter(Boolean);
	if (!parts.length) return { segments: [], error: "The scoped classes pattern is empty." };
	const segments: RegExp[] = [];
	for (const part of parts) {
		try {
			segments.push(new RegExp(`^(?:${part})$`));
		} catch {
			return { segments: [], error: `The scoped classes pattern has an invalid segment: ${part}` };
		}
	}
	return { segments };
}

/** Every folder below `base` that matches the segments one level at a time, sorted. */
export function matchPattern(base: string, segments: RegExp[], host: ScopeHost): string[] {
	let level = [normaliseFolder(base)];
	for (const segment of segments) {
		const next: string[] = [];
		for (const folder of level) {
			for (const name of [...host.childFolders(folder)].sort()) {
				if (segment.test(name)) next.push(folder ? `${folder}/${name}` : name);
			}
		}
		level = next;
		if (!level.length) break;
	}
	return level;
}

/** `80-89 Divorce` → `8`: an area folder is named for its ten categories. */
export function areaDigit(folderName: string): string | undefined {
	const m = folderName.match(/^(\d)0-\1 ?9(?:\s|$)/);
	return m ? m[1] : undefined;
}

/**
 * The classes folders a scope note owns.
 *
 * - The scope note's `classesKey` (a folder path, or a list of them) wins when present. Only
 *   folders that exist count.
 * - Otherwise the pattern, below the scope's folder.
 * - An area has no `.03` slot of its own, so for a folder named like `80-89 Divorce` the pattern
 *   runs below its management category, the child folder whose name starts with `80 `. Its classes
 *   are therefore the management category's too, and the index de-duplicates the shared folder.
 * - A root note at the top of the vault owns nothing: the root's folder is `classFilesPath`.
 */
export function classesFoldersOf(
	scopeNote: string,
	host: ScopeHost,
	settings: ScopeSettings,
	segments: RegExp[]
): string[] {
	const declared = host.frontmatterOf(scopeNote)?.[settings.classesKey];
	const list = Array.isArray(declared) ? declared : declared != null ? [declared] : [];
	const explicit = list
		.map((v) => linkTarget(v))
		.filter((v): v is string => !!v)
		.map(normaliseFolder);
	if (explicit.length) return [...new Set(explicit.filter((f) => host.isFolder(f)))];

	const folder = parentFolder(scopeNote);
	if (!folder || !segments.length) return [];
	const digit = areaDigit(baseName(folder));
	if (digit !== undefined) {
		const management = [...host.childFolders(folder)].sort().find((name) => name.startsWith(`${digit}0 `));
		return management ? matchPattern(`${folder}/${management}`, segments, host) : [];
	}
	return matchPattern(folder, segments, host);
}

/**
 * True when some run of a folder path's segments matches the pattern — the folder *is*, or sits
 * inside, a folder the pattern would name below some scope. Used to notice a new classes folder on
 * its first file, before any rebuild has recorded it.
 */
export function matchesPatternPath(folder: string, segments: RegExp[]): boolean {
	if (!segments.length) return false;
	const parts = normaliseFolder(folder).split("/").filter(Boolean);
	for (let i = 0; i + segments.length <= parts.length; i++) {
		if (segments.every((re, k) => re.test(parts[i + k]))) return true;
	}
	return false;
}
