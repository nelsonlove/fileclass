/*
 * The index with scoped classes (§10.3), on an in-memory vault behind a fake App. The `obsidian`
 * package ships types only; vitest.config.ts aliases it to tests/unit/stubs/obsidian.ts.
 */
import { describe, expect, it } from "vitest";

import { App, TFile, TFolder } from "obsidian";
import { FileclassIndex } from "../../src/schema/fileclassIndex";
import { DEFAULT_SETTINGS, FileclassSettings } from "../../src/settings/settings";
import { FakeVault, Files } from "./fakeVault";

const ROOT = "Classes/";

/** A fake App over a FakeVault: just what the index reads. */
function appOver(v: FakeVault): App {
	const files = new Map<string, TFile>();
	const folders = new Map<string, TFolder>();
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
		},
		metadataCache: {
			getFileCache: (f: TFile) => ({ frontmatter: v.files[f.path] }),
			getFirstLinkpathDest: (link: string) => {
				const p = v.resolveLink(link);
				return p ? files.get(p) ?? null : null;
			},
		},
		workspace: { trigger: () => undefined },
	};
	return app as unknown as App;
}

function indexOver(files: Files, overrides: Partial<FileclassSettings> = {}, extraFolders: string[] = []) {
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
	return { index, file, v };
}

const field = (name: string, id = name) => ({ name, id, type: "Input", options: {}, path: "" });

/** One root, one area with its management category, a second category with no up, a dup scope. */
function fixture(): Files {
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

const names = (fields: { name: string }[]) => fields.map((f) => f.name);

describe("scoped classes off", () => {
	it("reads the root alone, as before", () => {
		const { index, file } = indexOver(fixture());
		expect(index.fileClassNames).not.toContain("Case");
		expect(index.isFileClassNote("80-89 D/80 M/80.03 Shapes/classes/Case.md")).toBe(false);
		expect(index.getFileClasses(file("80-89 D/85 E/85.11 V/visit.md"))).toEqual(["Event/Visit"]);
		expect(names(index.getFields(file("80-89 D/85 E/85.11 V/visit.md")))).toEqual(["when"]);
		expect(index.errors).toEqual([]);
	});

	it("does not rebuild for a scoped path", () => {
		const { index } = indexOver(fixture());
		expect(index.affectsSchema("Classes/Book.md")).toBe(true);
		expect(index.affectsSchema("80-89 D/80 M/80.03 Shapes/classes/Case.md")).toBe(false);
		expect(index.affectsSchema("80-89 D/80-89 D.md")).toBe(false);
	});
});

describe("scoped classes on", () => {
	const on = { enableScopedClasses: true };

	it("a scope's class shadows the root's for its notes only, and the shadow is reported", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(names(index.getFields(file("80-89 D/85 E/85.11 V/visit.md")))).toEqual(["when", "supervisor"]);
		expect(names(index.getFields(file("Notes/visit.md")))).toEqual(["when"]);
		expect(index.errors.some((e) => /Event\/Visit in 80-89 D\/80 M\/.* shadows Event\/Visit in Classes\/Event\/Visit\.md/.test(e))).toBe(true);
	});

	it("extends to the shadowed class: a class never extends itself", () => {
		const { index, file } = indexOver(fixture(), on);
		const fields = index.getFields(file("80-89 D/85 E/85.11 V/visit.md"));
		expect(fields.find((f) => f.name === "when")).toBeTruthy();
		// The root's accessors by bare name still mean the root's class.
		expect(index.getAncestors("Event/Visit")).toEqual([]);
	});

	it("extends reaches a root class from a scope with no up", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(index.getFileClasses(file("40 F/ledger.md"))).toEqual(["Ledger"]);
		expect(names(index.getFields(file("40 F/ledger.md")))).toEqual(["author", "account"]);
		// Outside its scope the name means nothing.
		expect(index.getFileClasses(file("Notes/ledger.md"))).toEqual([]);
	});

	it("a scoped mapWithTag binds inside its scope only", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(index.getFileClasses(file("80-89 D/85 E/85.11 V/case.md"))).toEqual(["Case"]);
		expect(index.getFileClasses(file("Notes/case.md"))).toEqual([]);
		// A root class's tag still reaches a note inside a scope.
		expect(index.getFileClasses(file("80-89 D/85 E/85.11 V/book.md"))).toEqual(["Book"]);
	});

	it("a name given twice in one scope binds neither, and is reported", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(index.getFileClasses(file("50 Dup/x.md"))).toEqual([]);
		expect(index.errors.some((e) => /gives the class X twice/.test(e))).toBe(true);
	});

	it("the folder note of a classes folder is not a class; a stray is reported", () => {
		const { index } = indexOver(fixture(), on);
		expect(index.isFileClassNote("80-89 D/80 M/80.03 Shapes/classes/classes.md")).toBe(false);
		expect(index.isFileClassNote("80-89 D/80 M/80.03 Shapes/classes/stray.md")).toBe(false);
		expect(index.errors.some((e) => e.includes("classes/classes.md"))).toBe(false);
		expect(index.errors.some((e) => e.includes("classes/stray.md") && /binds nothing/.test(e))).toBe(true);
		expect(index.isFileClassNote("80-89 D/80 M/80.03 Shapes/classes/Case.md")).toBe(true);
	});

	it("a class note in a scoped folder carries no global class", () => {
		const files = fixture();
		files["Classes/Global.md"] = { type: "Meta/Fileclass", fields: [field("g")] };
		const { index, file } = indexOver(files, { ...on, globalFileClass: "Global" });
		expect(index.getFileClasses(file("80-89 D/80 M/80.03 Shapes/classes/Case.md"))).not.toContain("Global");
		expect(index.getFileClasses(file("40 F/ledger.md"))).toContain("Global");
	});

	it("rebuilds for a scope note, a scoped class, and a new classes folder", () => {
		const { index } = indexOver(fixture(), on);
		expect(index.affectsSchema("80-89 D/80-89 D.md")).toBe(true);
		expect(index.affectsSchema("80-89 D/80 M/80.03 Shapes/classes/Case.md")).toBe(true);
		expect(index.affectsSchema("30 New/30.03 Shapes/classes/Thing.md")).toBe(true);
		expect(index.affectsSchema("Notes/book.md")).toBe(false);
	});

	it("reports a broken up link and still reaches the root", () => {
		const files = fixture();
		files["40 F/40 F.md"] = { type: "Meta/Scope/Category", up: "[[Nowhere]]" };
		const { index, file } = indexOver(files, on);
		expect(index.errors.some((e) => /does not resolve/.test(e))).toBe(true);
		expect(index.getFileClasses(file("40 F/ledger.md"))).toEqual(["Ledger"]);
	});
});

describe("the root binds the same notes, off and on", () => {
	/** Every note's classes and fields, for the notes that are not class notes. */
	function snapshot(files: Files, enable: boolean, globalFileClass = "") {
		const { index, file } = indexOver(files, { enableScopedClasses: enable, globalFileClass });
		const out: Record<string, { classes: string[]; fields: string[] }> = {};
		for (const p of Object.keys(files)) {
			if (index.isFileClassNote(p)) continue;
			const f = file(p);
			out[p] = { classes: index.getFileClasses(f), fields: names(index.getFields(f)) };
		}
		return out;
	}

	it("with scopes present and no root name given again, every note is unchanged", () => {
		const files = fixture();
		// Drop the shadow and the scoped classes' own notes: what is left is the root's business.
		delete files["80-89 D/80 M/80.03 Shapes/classes/Event/Visit.md"];
		files["Classes/Global.md"] = { type: "Meta/Fileclass", fields: [field("g")] };
		const off = snapshot(files, false, "Global");
		const on = snapshot(files, true, "Global");
		const scopedNames = ["Case", "Ledger", "X"];
		// The notes that are notes under both settings: the scoped class files become class notes.
		for (const p of Object.keys(on)) {
			const rootOnly = (s: { classes: string[] }) => s.classes.filter((c) => !scopedNames.includes(c));
			expect(rootOnly(on[p]), p).toEqual(rootOnly(off[p]));
			if (on[p].classes.every((c) => !scopedNames.includes(c))) expect(on[p].fields, p).toEqual(off[p].fields);
		}
	});

	it("with a shadow, every note outside the shadowing scope is unchanged", () => {
		const files = fixture();
		const off = snapshot(files, false);
		const on = snapshot(files, true);
		for (const p of Object.keys(off)) {
			if (p.startsWith("80-89 D/") || p.startsWith("40 F/") || p.startsWith("50 Dup/")) continue;
			expect(on[p], p).toEqual(off[p]);
		}
	});
});
