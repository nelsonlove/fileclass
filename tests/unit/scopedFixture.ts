/*
 * The scoped-classes fixture shared by the index, API and command tests (§10.3): an in-memory vault
 * behind a fake App, and an index over it. The `obsidian` package ships types only; vitest.config.ts
 * aliases it to tests/unit/stubs/obsidian.ts.
 */
import { App, TFile, TFolder } from "obsidian";
import { FileclassIndex } from "../../src/schema/fileclassIndex";
import { DEFAULT_SETTINGS, FileclassSettings } from "../../src/settings/settings";
import { FakeVault, Files } from "./fakeVault";

export type { Files };

export const ROOT = "Classes/";

/** A fake App over a FakeVault: just what the index reads. */
export function appOver(v: FakeVault): App {
	const files = new Map<string, TFile>();
	const folders = new Map<string, TFolder>();
	const created: { path: string; data: string }[] = [];
	const active: { file: TFile | null } = { file: null };
	const folder = (path: string): TFolder => {
		let f = folders.get(path);
		if (!f) {
			f = new (TFolder as unknown as new (p: string) => TFolder)(path);
			folders.set(path, f);
		}
		return f;
	};
	for (const path of [...v.folders].sort()) {
		const f = folder(path);
		if (path) folder(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "").children.push(f);
	}
	for (const path of Object.keys(v.files)) {
		const file = new (TFile as unknown as new (p: string) => TFile)(path);
		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		(file as unknown as { parent: { path: string } }).parent = { path: parent || "/" };
		files.set(path, file);
		folder(parent).children.push(file);
	}
	const app = {
		vault: {
			getMarkdownFiles: () => [...files.values()],
			getAbstractFileByPath: (p: string) => files.get(p) ?? (p ? folders.get(p) : undefined) ?? null,
			getFileByPath: (p: string) => files.get(p) ?? null,
			getRoot: () => folder(""),
			getFolderByPath: (p: string) => folders.get(p) ?? null,
			createFolder: async (p: string) => {
				v.folders.add(p);
				return folder(p);
			},
			create: async (p: string, data: string) => {
				created.push({ path: p, data });
				const file = new (TFile as unknown as new (p: string) => TFile)(p);
				files.set(p, file);
				return file;
			},
		},
		metadataCache: {
			getFileCache: (f: TFile) => ({ frontmatter: v.files[f.path] }),
			getFirstLinkpathDest: (link: string) => {
				const p = v.resolveLink(link);
				return p ? files.get(p) ?? null : null;
			},
		},
		workspace: { trigger: () => undefined, getActiveFile: () => active.file },
		/** What `vault.create` was asked to write, in order. */
		created,
		/** The note `workspace.getActiveFile()` answers; set it in a test. */
		active,
	};
	return app as unknown as App;
}

export function indexOver(files: Files, overrides: Partial<FileclassSettings> = {}, extraFolders: string[] = []) {
	const v = new FakeVault(files, extraFolders);
	const app = appOver(v);
	const settings: FileclassSettings = {
		...DEFAULT_SETTINGS,
		classFilesPath: ROOT,
		fileClassAlias: "type",
		...overrides,
	};
	const index = new FileclassIndex({ app, settings });
	index.rebuild();
	const file = (p: string) => app.vault.getFileByPath(p) as TFile;
	const fake = app as unknown as { created: { path: string; data: string }[]; active: { file: TFile | null } };
	return { index, file, v, app, settings, created: fake.created, active: fake.active };
}

export const field = (name: string, id = name) => ({ name, id, type: "Input", options: {}, path: "" });

/** One root, one area with its management category, a second category with no up, a dup scope. */
export function fixture(): Files {
	return {
		// -- the root's classes
		"Classes/Note.md": { type: "Meta/Fileclass" },
		"Classes/Meta/Fileclass.md": { type: "Meta/Fileclass" },
		"Classes/Meta/Scope.md": { type: "Meta/Fileclass", extends: "Note" },
		"Classes/Meta/Scope/Area.md": { type: "Meta/Fileclass", extends: "Meta/Scope" },
		"Classes/Meta/Scope/Category.md": { type: "Meta/Fileclass", extends: "Meta/Scope/Area" },
		"Classes/Meta/Scope/Root.md": { type: "Meta/Fileclass", extends: "Meta/Scope" },
		"Classes/Event/Visit.md": { type: "Meta/Fileclass", fields: [field("when")] },
		"Classes/Book.md": { type: "Meta/Fileclass", mapWithTag: true, fields: [field("author")] },
		// -- scopes
		"Top.md": { type: "Meta/Scope/Root" },
		"80-89 D/80-89 D.md": { type: "Meta/Scope/Area", up: "[[Top]]" },
		"80-89 D/80 M/80 M.md": { type: "Meta/Scope/Category", up: "[[80-89 D]]" },
		"80-89 D/85 E/85 E.md": { type: "Meta/Scope/Category", up: "[[80-89 D]]" },
		"40 F/40 F.md": { type: "Meta/Scope/Category" },
		"50 Dup/50 Dup.md": { type: "Meta/Scope/Category", classes: ["50 Dup/a", "50 Dup/b"] },
		// -- scoped classes
		"80-89 D/80 M/80.03 Shapes/classes/classes.md": { type: "Meta/Collection" },
		"80-89 D/80 M/80.03 Shapes/classes/Event/Visit.md": {
			type: "Meta/Fileclass",
			extends: "Event/Visit",
			fields: [field("supervisor")],
		},
		"80-89 D/80 M/80.03 Shapes/classes/Case.md": { type: "Meta/Fileclass", mapWithTag: true, fields: [field("docket")] },
		"80-89 D/80 M/80.03 Shapes/classes/stray.md": { type: "Note" },
		"40 F/40.03 Shapes/classes/Ledger.md": { type: "Meta/Fileclass", extends: "Book", fields: [field("account")] },
		"50 Dup/a/X.md": { type: "Meta/Fileclass" },
		"50 Dup/b/X.md": { type: "Meta/Fileclass" },
		// -- notes
		"Notes/book.md": { type: "Book" },
		"Notes/tagged.md": { tags: ["book"] },
		"Notes/visit.md": { type: "Event/Visit" },
		"Notes/case.md": { tags: ["case"] },
		"Notes/ledger.md": { type: "Ledger" },
		"80-89 D/85 E/85.11 V/visit.md": { type: "Event/Visit" },
		"80-89 D/85 E/85.11 V/case.md": { tags: ["case"] },
		"80-89 D/85 E/85.11 V/book.md": { tags: ["book"] },
		"40 F/ledger.md": { type: "Ledger" },
		"50 Dup/x.md": { type: "X" },
	};
}

