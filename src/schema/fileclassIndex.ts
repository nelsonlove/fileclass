/*
 * FileclassIndex (ARCHITECTURE.md §10). The slim successor of Metadata Menu's
 * FieldIndex, keeping only: the fileClass registry (parsed notes under
 * classFilesPath), ancestors, resolved fields per class, and the file→fileClass
 * binding maps. Frontmatter-only reads (D2); no dataview, no IndexedDB.
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
	classNamesOf,
	isFolderNote,
	isScopeNote,
	matchesPatternPath,
	normaliseFolder,
	parentFolder,
	parsePattern,
	SCOPED_CLASS_TYPE,
	ScopeHost,
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
		this.folderScope.clear();
		this.bookmarkGroupsByPath.clear();
		this.errors = [];
	}

	/** Is this note a fileClass declaration — a file of a class folder? */
	private isClassNote(file: TFile): boolean {
		const folder = this.host.settings.classFilesPath;
		return (!!folder && file.path.startsWith(folder)) || this.nameByPath.has(file.path);
	}

	private indexFileClassNote(file: TFile, name: string): void {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const parsed = parseFileClass(name, frontmatter);
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
				// The classes folder's own folder note is expected there; anything else is a stray.
				if (file.path !== `${folder}/${folder.slice(folder.lastIndexOf("/") + 1)}.md`) {
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
						else if (known !== path) {
							layer.set(name, null);
							errors.add(`Scope ${scope} gives the class ${name} twice (${known ?? "an earlier file"} and ${path}); neither binds.`);
						}
					}
				}
				layers.push(layer);
			}
			layers.push(this.layersByScope.get(ROOT)?.[0] ?? new Map());
			this.layersByScope.set(note, layers);
		}

		// Index each scoped class once, under the scope with the longest chain among its owners:
		// a management category's, not its area's, when the two share a folder.
		for (const [folder, classes] of classesInFolder) {
			let owner: string | undefined;
			for (const [note, folders] of ownFolders) {
				if (!folders.includes(folder)) continue;
				if (owner === undefined || (chainLengthOf.get(note) ?? 0) > (chainLengthOf.get(owner) ?? 0)) owner = note;
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
		const parentOf = (path: string) => {
			const ext = this.byPath.get(path)?.options.extends;
			return ext ? this.lookup(this.scopeOfClass.get(path) ?? ROOT, ext, path) : undefined;
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
	// A bare name means the root scope's class (§10.3); a context parameter comes with PR 2.

	get fileClassNames(): string[] {
		return [...this.pathByName.keys()];
	}

	getFileClass(name: string): ParsedFileClass | undefined {
		const path = this.pathByName.get(name);
		return path ? this.byPath.get(path) : undefined;
	}

	getAncestors(name: string): string[] {
		const path = this.pathByName.get(name);
		const ancestors = path ? this.ancestorsByPath.get(path) ?? [] : [];
		return ancestors.map((p) => this.nameByPath.get(p) ?? p);
	}

	/** Resolved Lucide icon name for a fileClass: its own `icon`, else an
	 * ancestor's, else the configured default. */
	resolveIcon(name: string): string {
		const path = this.pathByName.get(name);
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
		return names.length ? this.resolveIcon(names[0]) : this.host.settings.fileClassIcon;
	}

	getResolvedFields(name: string): Field[] {
		const path = this.pathByName.get(name);
		return path ? this.fieldsByPath.get(path) ?? [] : [];
	}

	/** True when `path` is a fileClass note (under a class-files folder). */
	isFileClassNote(path: string): boolean {
		return this.nameByPath.has(path);
	}

	/** fileClass name for a note path, if it is a fileClass note. */
	fileClassNameOfNote(path: string): string | undefined {
		return this.nameByPath.get(path);
	}

	/** The Markdown note backing a fileClass, from the index (falling back to the conventional path) */
	getFileClassFile(name: string): TFile | null {
		const path = this.pathByName.get(name);
		if (path) {
			const file = this.app.vault.getFileByPath(path);
			if (file instanceof TFile) return file;
		}
		// Not indexed yet (class created before the debounced rebuild fired).
		const folder = this.host.settings.classFilesPath;
		if (!folder) return null;
		const file = this.app.vault.getFileByPath(`${folder}${name}.md`);
		return file instanceof TFile ? file : null;
	}
}
