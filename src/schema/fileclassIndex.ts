/*
 * FileclassIndex (ARCHITECTURE.md §10). The slim successor of Metadata Menu's
 * FieldIndex, keeping only: the fileClass registry (parsed notes under
 * classFilesPath and, with scoped classes on, each scope's classes folder, §10.3),
 * ancestors, resolved fields per class, and the file→fileClass binding maps, per
 * scope. Frontmatter-only reads (D2); no dataview, no IndexedDB.
 *
 * Rebuild is driven by main.ts (debounced metadataCache 'resolved' + fileClass
 * file changes). On each rebuild it fires the `fileclass:indexed` event.
 */
import { App, BookmarkItem, Events, TFile, TFolder, getAllTags } from "obsidian";

import { dateFormatDefaults, FileclassSettings } from "../settings/settings";
import { withDefaultDateFormats } from "../fields/dateFormats";
import { Field } from "./field";
import {
	fileClassNameFromPath,
	ParsedFileClass,
	parseFileClass,
	toStringArray,
} from "./fileClass";
import { computeAncestors, resolveInheritedFields } from "./inheritance";
import { applyFieldOrder } from "./fieldOrder";
import {
	BindingOrigin,
	FileBinding,
	FileClassRegistry,
	resolveBinding,
	Resolution,
} from "./resolver";
import {
	chainOf,
	classesFoldersOf,
	classesFolderToCreate,
	classNamesOf,
	isFolderNote,
	isScopeNote,
	matchesPatternPath,
	normaliseFolder,
	parentFolder,
	parsePattern,
	SCOPED_CLASS_TYPE,
	ScopeHost,
	scopeOfFolder,
	scopeOfNote,
	ScopeSettings,
} from "./scopeChain";

/** Minimal host contract (satisfied structurally by the plugin instance). */
export interface IndexHost {
	app: App;
	settings: FileclassSettings;
}

export const INDEXED_EVENT = "fileclass:indexed";

/** The scope key of the root scope: the one `classFilesPath` holds. */
const ROOT = "";

/**
 * One layer of a scope chain: name → class path, or `null` for a name that two files of the same
 * scope give (an error, so the name binds nothing in that scope and does not fall through).
 */
type Layer = Map<string, string | null>;

/** What a class name is read from: a note, or a note's, scope note's, class file's or folder's path. */
export type ClassContext = TFile | string;

/** One class of the index: its name, its file, and its scope ("" for the root). */
export interface ClassEntry {
	name: string;
	path: string;
	scope: string;
}

/** One name that one scope's classes folders give more than once: it binds nothing there. */
export interface DuplicateClass {
	/**
	 * Every scope note whose own classes folders give the name more than once, sorted: the scopes
	 * whose notes break, with the scopes below them unless a nearer scope gives the name. Not the
	 * owner of the folders, which may be another scope that does not give the clash.
	 */
	scopes: string[];
	name: string;
	/** Every file that gives the name, sorted by code unit. */
	paths: string[];
}

/** Code-unit order: the same on every machine, so a fingerprint built from it does not move with the locale. */
function byCodeUnit(x: string, y: string): number {
	return x < y ? -1 : x > y ? 1 : 0;
}

/** The binding maps the pure resolver reads, for one scope. */
interface Bindings {
	tagBindings: Map<string, string>;
	pathBindings: Map<string, string>;
	bookmarkBindings: Map<string, string>;
}

export class FileclassIndex extends Events {
	/** Class path → parsed class. A class's identity is its file (§10.3); a name is not unique. */
	private byPath = new Map<string, ParsedFileClass>();
	private nameByPath = new Map<string, string>();
	/** The root scope's name → path: what every bare-name accessor reads. */
	private pathByName = new Map<string, string>();
	/** Class path → its ancestors' paths, nearest first. */
	private ancestorsByPath = new Map<string, string[]>();
	private fieldsByPath = new Map<string, Field[]>();
	/** Class path → the scope its `extends` resolves from. */
	private scopeOfClass = new Map<string, string>();
	/** Scope key → its layers, nearest first, the root's last. The root's is `[rootLayer]`. */
	private layersByScope = new Map<string, Layer[]>();
	/** Scope key → the binding maps of the classes visible there. */
	private bindingsByScope = new Map<string, Bindings>();
	/** Every scoped classes folder found by the last rebuild. */
	private scopedFolders = new Set<string>();
	/** Scope key → its chain of scope notes, nearest first (the root not included). */
	private chainByScope = new Map<string, string[]>();
	/** Scope key → its own classes folders. */
	private foldersByScope = new Map<string, string[]>();
	/** Folder → scope key, filled lazily as notes are resolved; cleared on rebuild. */
	private folderScope = new Map<string, string | undefined>();
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
	/**
	 * Name + its files → one clash (ARCHITECTURE.md §10.3): a scope's folders give the name more than once.
	 * Kept apart from `errors` so the audit can log it as a finding, once per clash however many
	 * chains or scope notes share the folders.
	 */
	private duplicates = new Map<string, { name: string; paths: string[]; scopes: Set<string> }>();
	/** Aggregated non-fatal parse problems from the last rebuild. */
	errors: string[] = [];

	constructor(private readonly host: IndexHost) {
		super();
	}

	private get app(): App {
		return this.host.app;
	}

	private get scoped(): boolean {
		return this.host.settings.enableScopedClasses === true;
	}

	// -- rebuild --------------------------------------------------------------

	/** Rescans the class-files folder(s) and recomputes every derived map. */
	rebuild(): void {
		this.clear();
		const classFilesPath = this.host.settings.classFilesPath;
		const rootLayer: Layer = new Map();
		if (classFilesPath) {
			const files = this.app.vault
				.getMarkdownFiles()
				.filter((f) => f.path.startsWith(classFilesPath));
			for (const file of files) {
				const name = fileClassNameFromPath(classFilesPath, file.path);
				if (!name) continue;
				this.indexFileClassNote(file, name);
				this.pathByName.set(name, file.path);
				rootLayer.set(name, file.path);
				this.scopeOfClass.set(file.path, ROOT);
			}
		}
		this.layersByScope.set(ROOT, [rootLayer]);
		if (this.scoped && classFilesPath) this.indexScopes();
		if (classFilesPath) {
			this.computeInheritance();
			this.reportShadows();
		}
		// Outside the class-folder guard: a vault can bookmark notes with no class at all, and
		// this map costs one walk of the bookmark tree.
		this.buildBookmarkMap();
		// Notify our own listeners and the workspace (external consumers).
		this.trigger(INDEXED_EVENT);
		this.app.workspace.trigger(INDEXED_EVENT);
	}

	private clear(): void {
		this.byPath.clear();
		this.nameByPath.clear();
		this.pathByName.clear();
		this.ancestorsByPath.clear();
		this.fieldsByPath.clear();
		this.scopeOfClass.clear();
		this.layersByScope.clear();
		this.bindingsByScope.clear();
		this.scopedFolders.clear();
		this.chainByScope.clear();
		this.foldersByScope.clear();
		this.folderScope.clear();
		this.bookmarkGroupsByPath.clear();
		this.duplicates.clear();
		this.errors = [];
	}

	/** Is this note a fileClass declaration — a file of the class folder, or of a scoped one? */
	private isClassNote(file: TFile): boolean {
		const folder = this.host.settings.classFilesPath;
		return (
			(!!folder && file.path.startsWith(folder)) ||
			this.nameByPath.has(file.path) ||
			this.scopedFolderOf(file.path) !== undefined
		);
	}

	private indexFileClassNote(file: TFile, name: string): void {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const parsed = parseFileClass(name, frontmatter);
		for (const field of parsed.fields) field.fileClassPath = file.path;
		this.byPath.set(file.path, parsed);
		this.nameByPath.set(file.path, name);
		if (parsed.errors.length) this.errors.push(...parsed.errors);
	}

	// -- scopes (§10.3) -------------------------------------------------------

	private scopeSettings(): ScopeSettings {
		const s = this.host.settings;
		return {
			typeKey: s.fileClassAlias,
			parentKey: s.scopeParentKey,
			classesKey: s.scopedClassesKey,
			pattern: s.scopedClassesPattern,
		};
	}

	/** The vault, as the pure scope walk sees it. */
	private scopeHost(): ScopeHost {
		const vault = this.app.vault;
		const cache = this.app.metadataCache;
		const scopeClass = this.host.settings.scopeClass;
		// Scope classes are root classes: the walk that finds scopes cannot depend on itself.
		const rootParent = (name: string): string | undefined => {
			const path = this.pathByName.get(name);
			return path ? this.byPath.get(path)?.options.extends : undefined;
		};
		return {
			frontmatterOf: (path) => {
				const file = vault.getAbstractFileByPath(path);
				return file instanceof TFile ? cache.getFileCache(file)?.frontmatter : undefined;
			},
			isFile: (path) => vault.getAbstractFileByPath(path) instanceof TFile,
			isFolder: (path) =>
				path === "" ? true : vault.getAbstractFileByPath(path) instanceof TFolder,
			childFolders: (path) => {
				const folder = path === "" ? vault.getRoot() : vault.getAbstractFileByPath(path);
				if (!(folder instanceof TFolder)) return [];
				return folder.children.filter((c) => c instanceof TFolder).map((c) => c.name);
			},
			resolveLink: (linkpath, source) => cache.getFirstLinkpathDest(linkpath, source)?.path,
			isScopeClass: (name) => {
				if (!this.pathByName.has(name)) return false;
				const seen = new Set<string>();
				let current: string | undefined = name;
				while (current && !seen.has(current)) {
					if (current === scopeClass) return true;
					seen.add(current);
					current = rootParent(current);
				}
				return false;
			},
		};
	}

	/**
	 * Finds every scope note, its chain and its classes folders, then indexes the class files of
	 * those folders and builds each scope's layers. Runs only with `enableScopedClasses` on.
	 */
	private indexScopes(): void {
		const host = this.scopeHost();
		const settings = this.scopeSettings();
		const { segments, error } = parsePattern(settings.pattern);
		if (error) this.errors.push(error);
		const rootFolder = normaliseFolder(this.host.settings.classFilesPath);
		const errors = new Set<string>();

		const scopeNotes = this.app.vault
			.getMarkdownFiles()
			.map((f) => f.path)
			.filter((p) => (isFolderNote(p) || parentFolder(p) === "") && isScopeNote(p, host, settings));

		// Each scope's own folders, minus the root's (the root's classes are read as the root's).
		const ownFolders = new Map<string, string[]>();
		for (const note of scopeNotes) {
			const folders = classesFoldersOf(note, host, settings, segments).filter(
				(f) => f !== rootFolder && !f.startsWith(`${rootFolder}/`)
			);
			ownFolders.set(note, folders);
			this.foldersByScope.set(note, folders);
			for (const f of folders) this.scopedFolders.add(f);
		}

		// The class files of every scoped folder, by folder: name → path.
		const classesInFolder = new Map<string, Map<string, string>>();
		for (const folder of this.scopedFolders) classesInFolder.set(folder, new Map());
		for (const file of this.app.vault.getMarkdownFiles()) {
			const folder = this.scopedFolderOf(file.path);
			if (folder === undefined) continue;
			const types: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[settings.typeKey];
			if (!classNamesOf(types).includes(SCOPED_CLASS_TYPE)) {
				// A folder note (of the classes folder or of a folder inside it) is expected there;
				// anything else is a stray.
				if (!isFolderNote(file.path)) {
					errors.add(`${file.path} sits in the classes folder ${folder} but is not a ${SCOPED_CLASS_TYPE}; it binds nothing.`);
				}
				continue;
			}
			const name = fileClassNameFromPath(folder, file.path);
			if (!name) continue;
			classesInFolder.get(folder)?.set(name, file.path);
		}

		// Chains and layers.
		const chainLengthOf = new Map<string, number>();
		for (const note of scopeNotes) {
			const { chain, errors: walkErrors } = chainOf(note, host, settings);
			walkErrors.forEach((e) => errors.add(e));
			chainLengthOf.set(note, chain.length);
			this.chainByScope.set(note, chain);
			const layers: Layer[] = [];
			const visited = new Set<string>();
			for (const scope of chain) {
				const folders = (ownFolders.get(scope) ?? []).filter((f) => !visited.has(f));
				folders.forEach((f) => visited.add(f));
				if (!folders.length) continue;
				const layer: Layer = new Map();
				for (const folder of folders) {
					for (const [name, path] of classesInFolder.get(folder) ?? []) {
						const known = layer.get(name);
						if (known === undefined) layer.set(name, path);
						else if (known !== path) layer.set(name, null);
					}
				}
				layers.push(layer);
			}
			layers.push(this.layersByScope.get(ROOT)?.[0] ?? new Map());
			this.layersByScope.set(note, layers);
		}
		// Clashes, once per scope note over all its own folders. Not from the chain layers above: a
		// layer there leaves out the folders a nearer scope already read, so it would see a subset of
		// a clash as a clash of its own. Any clash such a layer holds is a subset of one found here.
		for (const note of scopeNotes) {
			const first = new Map<string, string>();
			// Only a name that clashes gets a set, so a scope without a clash allocates nothing more.
			const clashing = new Map<string, Set<string>>();
			for (const folder of ownFolders.get(note) ?? []) {
				for (const [name, path] of classesInFolder.get(folder) ?? []) {
					const known = first.get(name);
					if (known === undefined) first.set(name, path);
					else if (known !== path) clashing.set(name, (clashing.get(name) ?? new Set([known])).add(path));
				}
			}
			for (const [name, paths] of clashing) this.noteDuplicate(note, name, paths);
		}
		// One line per clash, from the same record the audit logs, so the two never disagree.
		for (const { scopes, name, paths } of this.duplicateClasses()) {
			errors.add(`${scopes.join(", ")} ${scopes.length > 1 ? "give" : "gives"} the class ${name} more than once (${paths.join(", ")}); none binds.`);
		}

		// Index each scoped class once, under the deepest owner whose folder holds the classes
		// folder: a management category's, not its area's, when the two share a folder, whether or
		// not the category has an `up` yet. The longer chain breaks a tie.
		const depthOf = (note: string, folder: string): number => {
			const scopeFolder = parentFolder(note);
			return scopeFolder && folder.startsWith(`${scopeFolder}/`) ? scopeFolder.split("/").length : 0;
		};
		for (const [folder, classes] of classesInFolder) {
			let owner: string | undefined;
			for (const [note, folders] of ownFolders) {
				if (!folders.includes(folder)) continue;
				const better =
					owner === undefined ||
					depthOf(note, folder) > depthOf(owner, folder) ||
					(depthOf(note, folder) === depthOf(owner, folder) &&
						(chainLengthOf.get(note) ?? 0) > (chainLengthOf.get(owner) ?? 0));
				if (better) owner = note;
			}
			if (owner === undefined) continue;
			for (const [name, path] of classes) {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) continue;
				this.indexFileClassNote(file, name);
				this.scopeOfClass.set(path, owner);
			}
		}
		this.errors.push(...errors);
	}

	/**
	 * Records one clash that `scope`'s own folders give, keyed by its name and its files, so a clash many
	 * chains or scope notes see is one, naming every scope whose own layer gives it.
	 */
	private noteDuplicate(scope: string, name: string, paths: Set<string>): void {
		const sorted = [...paths].sort(byCodeUnit);
		const key = `${name}\u0000${sorted.join("\u0000")}`;
		const known = this.duplicates.get(key);
		if (known) known.scopes.add(scope);
		else this.duplicates.set(key, { name, paths: sorted, scopes: new Set([scope]) });
	}

	/**
	 * Every name a scope gives twice or more, once per set of files, in a stable order (ARCHITECTURE.md §10.3).
	 * Empty with scoped classes off: the root's classes folder cannot give a name twice.
	 */
	duplicateClasses(): DuplicateClass[] {
		return [...this.duplicates.values()]
			.map(({ name, paths, scopes }) => ({ scopes: [...scopes].sort(byCodeUnit), name, paths: [...paths] }))
			.sort((a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(a.paths.join("\u0000"), b.paths.join("\u0000")));
	}

	/** The scoped classes folder a path sits in, if any. */
	private scopedFolderOf(path: string): string | undefined {
		for (let folder = parentFolder(path); folder; folder = parentFolder(folder)) {
			if (this.scopedFolders.has(folder)) return folder;
		}
		return undefined;
	}

	/**
	 * The class a name means in a scope: the first layer that names it, nearest first. `skip` is
	 * the class asking, so a class whose `extends` is its own name resolves to the class it
	 * shadows, never to itself.
	 */
	private lookup(scope: string, name: string, skip?: string): string | undefined {
		const layers = this.layersByScope.get(scope) ?? this.layersByScope.get(ROOT) ?? [];
		for (const layer of layers) {
			const path = layer.get(name);
			if (path === undefined || path === skip) continue;
			return path ?? undefined;
		}
		return undefined;
	}

	/** One line per class that shadows another of the same name further up its chain. */
	private reportShadows(): void {
		const seen = new Set<string>();
		for (const layers of this.layersByScope.values()) {
			for (let i = 0; i < layers.length; i++) {
				for (const [name, path] of layers[i]) {
					if (!path) continue;
					for (let j = i + 1; j < layers.length; j++) {
						const further = layers[j].get(name);
						if (!further || further === path) continue;
						const key = `${path}\u0000${further}`;
						if (!seen.has(key)) {
							seen.add(key);
							this.errors.push(`${name} in ${path} shadows ${name} in ${further} for the notes of its scope.`);
						}
						break;
					}
				}
			}
		}
	}

	/** The scope key of a note: its scope note, or the root. */
	scopeKeyOf(file: TFile): string {
		if (!this.scoped) return ROOT;
		const note = scopeOfNote(file.path, this.scopeHost(), this.scopeSettings(), this.folderScope);
		return note && this.layersByScope.has(note) ? note : ROOT;
	}

	private computeInheritance(): void {
		// A parent that names no class stays in the chain by its bare name, as it always has
		// (getAncestors shows it, and it contributes no fields); one that names the class itself
		// does not, so a self-reference still gives no ancestors.
		const parentOf = (path: string) => {
			const ext = this.byPath.get(path)?.options.extends;
			if (!ext) return undefined;
			const found = this.lookup(this.scopeOfClass.get(path) ?? ROOT, ext, path);
			return found ?? (ext === this.nameByPath.get(path) ? undefined : ext);
		};
		for (const path of this.byPath.keys()) {
			const ancestors = computeAncestors(path, parentOf);
			this.ancestorsByPath.set(path, ancestors);
			const fields = resolveInheritedFields(
				path,
				ancestors,
				(cls) => this.byPath.get(cls)?.fields ?? [],
				(cls) => this.byPath.get(cls)?.options.excludes ?? []
			);
			// The chain gives a default; the class may hold its own order over the whole set,
			// inherited fields included (fieldOrder.ts). Applied here because this is the one place
			// a resolved set is built — every surface reads it from here.
			const order = this.byPath.get(path)?.options.fieldsOrder ?? [];
			this.fieldsByPath.set(path, applyFieldOrder(fields, order));
		}
	}

	/**
	 * The binding maps of one scope: those of every class visible there. Farthest layer first, so
	 * a nearer class's tag or folder wins inside its scope and reaches no note outside it. The
	 * root's are the maps the index has always built, in the same order.
	 */
	private bindingsFor(scope: string): Bindings {
		const cached = this.bindingsByScope.get(scope);
		if (cached) return cached;
		const bindings: Bindings = {
			tagBindings: new Map(),
			pathBindings: new Map(),
			bookmarkBindings: new Map(),
		};
		const layers = this.layersByScope.get(scope) ?? this.layersByScope.get(ROOT) ?? [];
		for (const layer of [...layers].reverse()) {
			for (const [name, path] of layer) {
				if (!path || this.lookup(scope, name) !== path) continue;
				const parsed = this.byPath.get(path);
				if (!parsed) continue;
				const { mapWithTag, tagNames, filesPaths, bookmarksGroups } = parsed.options;
				// mapWithTag → the fileClass name itself is the tag (single-word only).
				// Lower case, because a tag's case is not part of its identity: see the note on
				// `tagBindings` in resolver.ts. The class keeps its own capitalisation everywhere
				// else — this is the lookup key, not the name.
				if (mapWithTag && !name.includes(" ")) bindings.tagBindings.set(name.toLowerCase(), name);
				for (const tag of tagNames) {
					if (!tag.includes(" ")) bindings.tagBindings.set(tag.toLowerCase(), name);
				}
				for (const p of filesPaths) bindings.pathBindings.set(p, name);
				for (const group of bookmarksGroups) bindings.bookmarkBindings.set(group, name);
			}
		}
		this.bindingsByScope.set(scope, bindings);
		return bindings;
	}

	// -- registry / resolution ------------------------------------------------

	/**
	 * A read-only registry view for the pure resolver, bound to the note's scope chain: a name
	 * means the nearest class that gives it, and only the classes visible there bind by tag,
	 * folder or bookmark. Without a file, or with scoped classes off, it is the root's.
	 *
	 * `forFile` also exists for one rule: the global fileClass never applies to a **class note**.
	 * A global class is meant for a vault where every note is the same kind of thing, and
	 * `Classes/Book.md` is not one of those things — it is the declaration itself. Measured
	 * before the guard: setting a global class typed the whole class folder with it, so the
	 * definitions showed up in their own class's views.
	 */
	registry(forFile?: TFile): FileClassRegistry {
		const global =
			forFile && this.isClassNote(forFile)
				? undefined
				: this.host.settings.globalFileClass || undefined;
		const scope = forFile ? this.scopeKeyOf(forFile) : ROOT;
		const bindings = this.bindingsFor(scope);
		return {
			has: (name) => this.lookup(scope, name) !== undefined,
			fieldsOf: (name) => {
				const path = this.lookup(scope, name);
				return path ? this.fieldsByPath.get(path) ?? [] : [];
			},
			tagBindings: bindings.tagBindings,
			pathBindings: bindings.pathBindings,
			bookmarkBindings: bindings.bookmarkBindings,
			globalFileClass: global,
			// presetFields: wired in a later phase (settings.presetFields).
		};
	}

	/**
	 * True when a changed path can change the schema (main.ts rebuilds on it). With scoped
	 * classes off: a Markdown file under the class folder, as always. On: also a file of a known
	 * scoped classes folder, a scope note or a folder note that could become one, and a file in a
	 * folder the classes pattern names, so a new `classes/` folder is seen on its first file.
	 */
	affectsSchema(path: string): boolean {
		if (!path.endsWith(".md")) return false;
		const folder = this.host.settings.classFilesPath;
		if (!folder) return false;
		if (path.startsWith(folder)) return true;
		if (!this.scoped) return false;
		if (this.layersByScope.has(path) || isFolderNote(path)) return true;
		if (this.scopedFolderOf(path) !== undefined) return true;
		const { segments } = parsePattern(this.host.settings.scopedClassesPattern);
		return matchesPatternPath(parentFolder(path), segments);
	}

	/** Builds a note's binding context from its metadata cache entry. */
	bindingFor(file: TFile): FileBinding {
		const cache = this.app.metadataCache.getFileCache(file);
		const alias = this.host.settings.fileClassAlias;
		const innerNames = toStringArray(cache?.frontmatter?.[alias]);
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
	// A class name means the nearest class that gives it, up the scope chain of a context
	// (§10.3). The context is a note (`TFile` or its path), a scope note's path, a class file's
	// path (its own scope, so a class reads its own definition), or a folder. No context, or one
	// that names nothing known, means the root scope — so every caller that passes a bare name
	// keeps reading the root's class, as before.

	/**
	 * The scope key a context means: a scope note's path, or "" for the root. With scoped classes
	 * off, always the root.
	 */
	scopeOf(ctx?: ClassContext): string {
		if (!this.scoped || ctx === undefined) return ROOT;
		const path = ctx instanceof TFile ? ctx.path : normaliseFolder(ctx);
		if (!path) return ROOT;
		if (this.layersByScope.has(path)) return path;
		// A class reads from its own scope, wherever its file sits.
		const owner = this.scopeOfClass.get(path);
		if (owner !== undefined) return owner;
		const file = ctx instanceof TFile ? ctx : this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) return this.scopeKeyOf(file);
		if (file instanceof TFolder) {
			const note = scopeOfFolder(path, this.scopeHost(), this.scopeSettings(), this.folderScope);
			return note && this.layersByScope.has(note) ? note : ROOT;
		}
		return ROOT;
	}

	/** The scopes a context sees, nearest first, the root ("") last. */
	chainOf(ctx?: ClassContext): string[] {
		const scope = this.scopeOf(ctx);
		return scope === ROOT ? [ROOT] : [...(this.chainByScope.get(scope) ?? [scope]), ROOT];
	}

	/** True when a context names a scope, a note, a class or a folder the index knows. */
	knowsContext(ctx: string): boolean {
		const path = normaliseFolder(ctx);
		return (
			!path ||
			this.layersByScope.has(path) ||
			this.scopeOfClass.has(path) ||
			this.app.vault.getAbstractFileByPath(path) !== null
		);
	}

	/** The class file a name means from a context, or undefined. */
	resolveClass(name: string, ctx?: ClassContext): string | undefined {
		return this.lookup(this.scopeOf(ctx), name);
	}

	/**
	 * The class an `extends` name means for a class file: read from the class's own scope upward,
	 * never the class itself, so a scope's class may extend the class it shadows.
	 */
	resolveParent(name: string, classPath: string): string | undefined {
		return this.lookup(this.scopeOfClass.get(classPath) ?? ROOT, name, classPath);
	}

	/** The root scope's class names. */
	get fileClassNames(): string[] {
		return [...this.pathByName.keys()];
	}

	/** The class names a context can see: its scopes' and the root's, a shadowed name once. */
	fileClassNamesFor(ctx?: ClassContext): string[] {
		const scope = this.scopeOf(ctx);
		if (scope === ROOT) return this.fileClassNames;
		const names = new Set<string>();
		for (const layer of this.layersByScope.get(scope) ?? []) {
			for (const name of layer.keys()) {
				if (this.lookup(scope, name) !== undefined) names.add(name);
			}
		}
		return [...names];
	}

	/**
	 * Every class the index holds, root and scoped, with its file and scope ("" for the root). A
	 * class whose name two files of one scope give is not listed: it binds nothing.
	 */
	allClasses(): ClassEntry[] {
		const out: ClassEntry[] = [];
		for (const [path, name] of this.nameByPath) {
			const scope = this.scopeOfClass.get(path) ?? ROOT;
			if (this.lookup(scope, name) !== path) continue;
			out.push({ name, path, scope });
		}
		return out;
	}

	getFileClass(name: string, ctx?: ClassContext): ParsedFileClass | undefined {
		const path = this.resolveClass(name, ctx);
		return path ? this.byPath.get(path) : undefined;
	}

	/** The parsed class of a class file path. */
	getFileClassByPath(path: string): ParsedFileClass | undefined {
		return this.byPath.get(path);
	}

	/** The ancestors' class files of a class file, nearest first. */
	ancestorPathsOf(classPath: string): string[] {
		return this.ancestorsByPath.get(classPath) ?? [];
	}

	/** The resolved fields of a class file. */
	resolvedFieldsOf(classPath: string): Field[] {
		return this.fieldsByPath.get(classPath) ?? [];
	}

	/** The names of a class's ancestors, nearest first. */
	getAncestors(name: string, ctx?: ClassContext): string[] {
		return this.getAncestorPaths(name, ctx).map((p) => this.nameByPath.get(p) ?? p);
	}

	/**
	 * The class files of a class's ancestors, nearest first. A parent that names no class stays
	 * as its bare name, as `getAncestors` has always shown it.
	 */
	getAncestorPaths(name: string, ctx?: ClassContext): string[] {
		const path = this.resolveClass(name, ctx);
		return path ? this.ancestorsByPath.get(path) ?? [] : [];
	}

	/** Resolved Lucide icon name for a fileClass: its own `icon`, else an
	 * ancestor's, else the configured default. */
	resolveIcon(name: string, ctx?: ClassContext): string {
		const path = this.resolveClass(name, ctx);
		const chain = path ? [path, ...(this.ancestorsByPath.get(path) ?? [])] : [];
		for (const cls of chain) {
			const icon = this.byPath.get(cls)?.options.icon;
			if (icon) return icon;
		}
		return this.host.settings.fileClassIcon;
	}

	/** Icon for a note, from its primary (first-bound) fileClass. */
	iconForFile(file: TFile): string {
		const names = this.getFileClasses(file);
		return names.length ? this.resolveIcon(names[0], file) : this.host.settings.fileClassIcon;
	}

	getResolvedFields(name: string, ctx?: ClassContext): Field[] {
		const path = this.resolveClass(name, ctx);
		return path ? this.fieldsByPath.get(path) ?? [] : [];
	}

	/**
	 * True when a note carries the class a name means from a context: the note binds the name and,
	 * from the note's own scope, the name means the same file. A note in a scope that shadows the
	 * name carries the shadow, not the class asked for.
	 */
	bindsClass(file: TFile, name: string, ctx?: ClassContext): boolean {
		const target = this.resolveClass(name, ctx);
		if (!target || !this.getFileClasses(file).includes(name)) return false;
		return this.resolveClass(name, file) === target;
	}

	/** True when `path` is a fileClass note (under a class-files folder). */
	isFileClassNote(path: string): boolean {
		return this.nameByPath.has(path);
	}

	/** fileClass name for a note path, if it is a fileClass note. */
	fileClassNameOfNote(path: string): string | undefined {
		return this.nameByPath.get(path);
	}

	/** The scope a class file belongs to ("" for the root), if it is one. */
	scopeOfClassFile(path: string): string | undefined {
		return this.scopeOfClass.get(path);
	}

	/** The classes folders of a scope: `classFilesPath` for the root, its own folders otherwise. */
	classesFoldersOfScope(scope: string): string[] {
		if (scope === ROOT) {
			const root = normaliseFolder(this.host.settings.classFilesPath);
			return this.host.settings.classFilesPath ? [root] : [];
		}
		return this.foldersByScope.get(scope) ?? [];
	}

	/**
	 * The folder a new class of a scope goes in: the root's `classFilesPath`, or the scope's first
	 * classes folder, or the one its pattern would name when it does not exist yet.
	 */
	classesFolderForNewClass(scope: string): string | undefined {
		if (scope === ROOT) {
			const root = this.host.settings.classFilesPath;
			return root ? normaliseFolder(root) : undefined;
		}
		const { segments } = parsePattern(this.host.settings.scopedClassesPattern);
		return classesFolderToCreate(scope, this.scopeHost(), this.scopeSettings(), segments);
	}

	/** Every scoped classes folder the last rebuild found. */
	scopedClassesFolders(): string[] {
		return [...this.scopedFolders];
	}

	/** Every scope note the index knows (the root excluded). */
	get scopeNotes(): string[] {
		return [...this.layersByScope.keys()].filter((k) => k !== ROOT);
	}

	/**
	 * The Markdown note backing a fileClass. A root name not indexed yet (a class created before
	 * the debounced rebuild fired) falls back to the root folder's conventional path.
	 */
	getFileClassFile(name: string, ctx?: ClassContext): TFile | null {
		const path = this.resolveClass(name, ctx);
		if (path) {
			const file = this.app.vault.getFileByPath(path);
			if (file instanceof TFile) return file;
		}
		if (this.scopeOf(ctx) !== ROOT) return null;
		const folder = this.host.settings.classFilesPath;
		if (!folder) return null;
		const file = this.app.vault.getFileByPath(`${folder}${name}.md`);
		return file instanceof TFile ? file : null;
	}
}
