/*
 * FileclassIndex (ARCHITECTURE.md §10). The slim successor of Metadata Menu's
 * FieldIndex, keeping only: the fileClass registry (every `.fileclass` file
 * vault-wide), ancestors, resolved fields per class, and the file→fileClass
 * binding maps. `.fileclass` files are read via vault.cachedRead + parseYaml
 * (not markdown, so not in metadataCache); no dataview, no IndexedDB.
 *
 * Rebuild is driven by main.ts (debounced metadataCache 'resolved' + fileClass
 * file changes). On each rebuild it fires the `fileclass:indexed` event.
 */
import { App, BookmarkItem, Events, TFile, getAllTags, parseYaml } from "obsidian";

import { dateFormatDefaults, FileclassSettings } from "../settings/settings";
import { FILECLASS_EXTENSION, FILECLASS_NAME_SUFFIX } from "./constants";
import { withDefaultDateFormats } from "../fields/dateFormats";
import { Field } from "./field";
import { fileClassNameFromFile, ParsedFileClass, parseFileClass } from "./fileClass";
import { splitFileClassSource } from "./fileClassSource";
import { computeAncestors, resolveInheritedFields } from "./inheritance";
import {
	BindingOrigin,
	FileBinding,
	FileClassRegistry,
	resolveBinding,
	resolveExtendsName,
	resolveInnerFileClassNames,
	Resolution,
} from "./resolver";

/** Minimal host contract (satisfied structurally by the plugin instance). */
export interface IndexHost {
	app: App;
	settings: FileclassSettings;
}

export const INDEXED_EVENT = "fileclass:indexed";

/** A definition file read during rebuild's async phase, before the sync swap. */
interface ReadFileClass {
	file: TFile;
	name: string;
	parsed: ParsedFileClass;
	ioError?: string;
}

export class FileclassIndex extends Events {
	private byName = new Map<string, ParsedFileClass>();
	private nameByPath = new Map<string, string>();
	/** Reverse of `nameByPath`; `rebuild()` clears and refills both together. */
	private pathByName = new Map<string, string>();
	private ancestorsByName = new Map<string, string[]>();
	private fieldsByName = new Map<string, Field[]>();
	private tagBindings = new Map<string, string>();
	private pathBindings = new Map<string, string>();
	private bookmarkBindings = new Map<string, string>();
	/**
	 * note path → the bookmark groups holding it, nested ones as `parent/child`, each note
	 * counted for its group and that group's ancestors.
	 *
	 * Built once per rebuild rather than asked per note: the alternative walks the whole
	 * bookmark tree for every note in the vault. It also closes a hole — the resolver has
	 * accepted `bookmarkGroups` since day one and nothing ever filled it, so a class bound to
	 * a bookmark group claimed nothing at all (#121's take found it).
	 */
	private bookmarkGroupsByPath = new Map<string, string[]>();
	/** Aggregated non-fatal parse problems from the last rebuild. */
	errors: string[] = [];
	// Rebuild is async (non-md reads); serialize overlapping calls and coalesce a
	// trailing one so `clear()` never interleaves with an in-flight population.
	private rebuildInFlight: Promise<void> | null = null;
	private rebuildQueued = false;

	constructor(private readonly host: IndexHost) {
		super();
	}

	private get app(): App {
		return this.host.app;
	}

	// -- rebuild --------------------------------------------------------------

	/**
	 * Rescans every `.fileclass` definition file vault-wide and recomputes derived
	 * maps. Async because `.fileclass` files are not markdown, so their schema is
	 * read via `vault.cachedRead` rather than the metadata cache. Overlapping calls
	 * are serialized (and a burst coalesced to one trailing run) so a concurrent
	 * `clear()` can never wipe an in-flight population.
	 */
	rebuild(): Promise<void> {
		if (this.rebuildInFlight) {
			this.rebuildQueued = true;
			return this.rebuildInFlight;
		}
		this.rebuildInFlight = this.runRebuild().finally(() => {
			this.rebuildInFlight = null;
			if (this.rebuildQueued) {
				this.rebuildQueued = false;
				void this.rebuild();
			}
		});
		return this.rebuildInFlight;
	}

	private async runRebuild(): Promise<void> {
		const files = this.app.vault.getFiles().filter((f) => f.extension === FILECLASS_EXTENSION);
		// Async READ phase — read every definition into locals without touching
		// shared state, so readers keep seeing the previous *complete* index.
		const results: ReadFileClass[] = [];
		for (const file of files) {
			const r = await this.readFileClassNote(file);
			if (r) results.push(r);
		}
		// Synchronous SWAP phase — no await here, so the index is never observed
		// cleared or half-populated: readers see either the old or the new complete
		// state (fixes blank-during-rebuild reads in the editors and base lookups).
		this.clear();
		for (const { file, name, parsed, ioError } of results) {
			const prior = this.pathByName.get(name);
			if (prior && prior !== file.path) {
				this.errors.push(`Duplicate fileClass "${name}": ${file.path} shadows ${prior}.`);
			}
			this.byName.set(name, parsed);
			this.nameByPath.set(file.path, name);
			this.pathByName.set(name, file.path);
			if (ioError) this.errors.push(ioError);
			if (parsed.errors.length) this.errors.push(...parsed.errors);
		}
		this.computeInheritance();
		this.buildBindingMaps();
		// A vault can bookmark notes with no class at all, and this map costs one walk
		// of the bookmark tree — so it is built unconditionally, like the binding maps.
		this.buildBookmarkMap();
		// Notify our own listeners and the workspace (external consumers).
		this.trigger(INDEXED_EVENT);
		this.app.workspace.trigger(INDEXED_EVENT);
	}

	private clear(): void {
		this.byName.clear();
		this.nameByPath.clear();
		this.pathByName.clear();
		this.ancestorsByName.clear();
		this.fieldsByName.clear();
		this.tagBindings.clear();
		this.pathBindings.clear();
		this.bookmarkBindings.clear();
		this.bookmarkGroupsByPath.clear();
		this.errors = [];
	}

	/**
	 * Is this file a fileClass declaration? Upstream tests membership of the class
	 * folder; this fork discovers definitions vault-wide by extension, so identity is
	 * the extension itself — no setting, and correct for a definition in any folder.
	 */
	private isClassNote(file: TFile): boolean {
		return !!fileClassNameFromFile(file);
	}

	/** Reads and parses one `.fileclass` file (no shared-state mutation). Returns
	 *  null for a non-fileClass file. Naming is vault-wide name-keyed, so same-named
	 *  files collide (surfaced during the swap phase). */
	private async readFileClassNote(file: TFile): Promise<ReadFileClass | null> {
		const name = fileClassNameFromFile(file);
		if (!name) return null;
		// `.fileclass` is not markdown, so parse the YAML block from the raw text.
		const raw = await this.app.vault.cachedRead(file);
		const { frontmatter } = splitFileClassSource(raw);
		let fm: Record<string, unknown> = {};
		let ioError: string | undefined;
		if (frontmatter.trim()) {
			try {
				const y: unknown = parseYaml(frontmatter);
				if (y && typeof y === "object") fm = y as Record<string, unknown>;
			} catch (e) {
				ioError = `Malformed YAML in ${file.path}: ${(e as Error).message}`;
			}
		}
		return { file, name, parsed: parseFileClass(name, fm), ioError };
	}

	private computeInheritance(): void {
		// `extends` may be a wikilink (`"[[Note.fileclass]]"`) or a bare/display
		// name; resolve each to a canonical registry name once, up front.
		const resolvedParent = new Map<string, string | undefined>();
		for (const name of this.byName.keys()) {
			const raw = this.byName.get(name)?.options.extends;
			const sourcePath = this.pathByName.get(name) ?? "";
			resolvedParent.set(
				name,
				resolveExtendsName(
					raw,
					(link) => {
						const dest = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
						return dest ? this.nameByPath.get(dest.path) : undefined;
					},
					(n) => this.byName.has(n)
				)
			);
		}
		const parentOf = (n: string) => resolvedParent.get(n);
		for (const name of this.byName.keys()) {
			const ancestors = computeAncestors(name, parentOf);
			this.ancestorsByName.set(name, ancestors);
			const fields = resolveInheritedFields(
				name,
				ancestors,
				(cls) => this.byName.get(cls)?.fields ?? [],
				(cls) => this.byName.get(cls)?.options.excludes ?? []
			);
			this.fieldsByName.set(name, fields);
		}
	}

	private buildBindingMaps(): void {
		for (const [name, parsed] of this.byName) {
			const { mapWithTag, tagNames, filesPaths, bookmarksGroups } = parsed.options;
			// mapWithTag → the fileClass name itself is the tag (single-word only).
			// Lower case, because a tag's case is not part of its identity: see the note on
			// `tagBindings` in resolver.ts. The class keeps its own capitalisation everywhere
			// else — this is the lookup key, not the name.
			if (mapWithTag && !name.includes(" ")) this.tagBindings.set(name.toLowerCase(), name);
			for (const tag of tagNames) {
				if (!tag.includes(" ")) this.tagBindings.set(tag.toLowerCase(), name);
			}
			for (const path of filesPaths) this.pathBindings.set(path, name);
			for (const group of bookmarksGroups) this.bookmarkBindings.set(group, name);
		}
	}

	// -- registry / resolution ------------------------------------------------

	/**
	 * Resolves the Global fileClass setting to an indexed name. The setting may be
	 * a bare name, a `.fileclass` name, or a path (legacy `classFilesPath` value);
	 * fileClass names now carry the `.fileclass` suffix, so match forgivingly.
	 */
	private resolveGlobalName(): string | undefined {
		const raw = this.host.settings.globalFileClass;
		if (!raw) return undefined;
		const base = (raw.split("/").pop() ?? raw).replace(/\.md$/, "");
		for (const cand of [raw, base, `${base}${FILECLASS_NAME_SUFFIX}`]) {
			if (this.byName.has(cand)) return cand;
		}
		return undefined;
	}

	/**
	 * A read-only registry view for the pure resolver.
	 *
	 * `forFile` exists for one rule: the global fileClass never applies to a **class
	 * note**. A global class is meant for a vault where every note is the same kind of
	 * thing, and `Book.fileclass` is not one of those things — it is the declaration
	 * itself. Measured upstream before the guard: setting a global class typed every
	 * definition with it, so they showed up in their own class's views.
	 */
	registry(forFile?: TFile): FileClassRegistry {
		const global = forFile && this.isClassNote(forFile) ? undefined : this.resolveGlobalName();
		return {
			has: (name) => this.byName.has(name),
			fieldsOf: (name) => this.fieldsByName.get(name) ?? [],
			tagBindings: this.tagBindings,
			pathBindings: this.pathBindings,
			bookmarkBindings: this.bookmarkBindings,
			globalFileClass: global,
			// presetFields: wired in a later phase (settings.presetFields).
		};
	}

	/** Builds a note's binding context from its metadata cache entry. */
	bindingFor(file: TFile): FileBinding {
		const cache = this.app.metadataCache.getFileCache(file);
		const alias = this.host.settings.fileClassAlias;
		const innerNames = resolveInnerFileClassNames(
			cache?.frontmatterLinks ?? [],
			alias,
			(link) => this.app.metadataCache.getFirstLinkpathDest(link, file.path)?.path ?? null,
			this.nameByPath
		);
		const tags = (cache ? getAllTags(cache) ?? [] : []).map((t) => t.replace(/^#/, ""));
		return {
			innerNames,
			tags,
			folderPath: file.parent?.path ?? "",
			bookmarkGroups: this.bookmarkGroupsByPath.get(file.path) ?? [],
		};
	}

	/**
	 * Walks the Bookmarks core plugin once, recording which groups hold each file. A file in
	 * `Films/Tarkovsky` counts for `Films/Tarkovsky` **and** `Films`, the way a nested tag
	 * counts for its parent — a class bound to the outer group claims what the inner one holds.
	 */
	private buildBookmarkMap(): void {
		const instance = this.app.internalPlugins?.plugins?.bookmarks?.instance;
		const items = instance?.getBookmarks?.();
		if (!items?.length) return;

		const walk = (list: BookmarkItem[], groups: string[]): void => {
			for (const item of list) {
				if (item.type === "group") {
					const title = (item.title ?? "").trim();
					if (!title) continue;
					const path = [...groups, title];
					walk(item.items ?? [], path);
					continue;
				}
				const filePath = typeof item.path === "string" ? item.path : "";
				if (!filePath || !groups.length) continue;
				// Every ancestor, most specific last — the order does not matter, the set does.
				const names = groups.map((_, i) => groups.slice(0, i + 1).join("/"));
				const known = this.bookmarkGroupsByPath.get(filePath) ?? [];
				this.bookmarkGroupsByPath.set(filePath, [...new Set([...known, ...names])]);
			}
		};
		walk(items, []);
	}

	/** Full binding resolution for a note (fileClasses + merged fields). */
	resolve(file: TFile): Resolution {
		const resolution = resolveBinding(this.bindingFor(file), this.registry(file));
		// Fold the plugin-wide write format into date fields that declare none, so
		// every consumer (input, validation, display parsing) sees one effective
		// format. No-op — the same array — when the defaults are blank.
		const fields = withDefaultDateFormats(resolution.fields, dateFormatDefaults(this.host.settings));
		return fields === resolution.fields ? resolution : { ...resolution, fields };
	}

	getFileClasses(file: TFile): string[] {
		return this.resolve(file).fileClassNames;
	}

	/** Why each of a note's classes applies — `#album`, `/Reading list`, `*Film club`. */
	getBindingOrigins(file: TFile): Map<string, BindingOrigin> {
		return this.resolve(file).origins;
	}

	getFields(file: TFile): Field[] {
		return this.resolve(file).fields;
	}

	// -- accessors ------------------------------------------------------------

	get fileClassNames(): string[] {
		return [...this.byName.keys()];
	}

	getFileClass(name: string): ParsedFileClass | undefined {
		return this.byName.get(name);
	}

	getAncestors(name: string): string[] {
		return this.ancestorsByName.get(name) ?? [];
	}

	/** Resolved Lucide icon name for a fileClass: its own `icon`, else an
	 * ancestor's, else the configured default. */
	resolveIcon(name: string): string {
		for (const cls of [name, ...this.getAncestors(name)]) {
			const icon = this.byName.get(cls)?.options.icon;
			if (icon) return icon;
		}
		return this.host.settings.fileClassIcon;
	}

	/** Icon for a note, from its primary (first-bound) fileClass. */
	iconForFile(file: TFile): string {
		const names = this.getFileClasses(file);
		return names.length ? this.resolveIcon(names[0]) : this.host.settings.fileClassIcon;
	}

	getResolvedFields(name: string): Field[] {
		return this.fieldsByName.get(name) ?? [];
	}

	/** True when `path` is a fileClass note (under the class-files folder). */
	isFileClassNote(path: string): boolean {
		return this.nameByPath.has(path);
	}

	/** fileClass name for a note path, if it is a fileClass note. */
	fileClassNameOfNote(path: string): string | undefined {
		return this.nameByPath.get(path);
	}

	/** The `.fileclass` definition backing a fileClass, resolved from the index
	 *  (falling back to a vault-wide filename lookup for a just-created class). */
	getFileClassFile(name: string): TFile | null {
		const path = this.pathByName.get(name);
		if (path) {
			const file = this.app.vault.getFileByPath(path);
			if (file instanceof TFile) return file;
		}
		// Not yet indexed (e.g. a class created just now, before the debounced
		// rebuild fires) — fall back to a direct vault lookup by filename.
		const match = this.app.vault
			.getFiles()
			.find((f) => f.extension === FILECLASS_EXTENSION && f.name === name);
		return match ?? null;
	}
}
