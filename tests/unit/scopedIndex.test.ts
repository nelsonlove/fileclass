/*
 * The index with scoped classes (§10.3), on an in-memory vault behind a fake App. The `obsidian`
 * package ships types only; vitest.config.ts aliases it to tests/unit/stubs/obsidian.ts.
 */
import { describe, expect, it } from "vitest";

import { field, Files, fixture, indexOver } from "./scopedFixture";

const names = (fields: { name: string }[]) => fields.map((f) => f.name);

describe("scoped classes off", () => {
	it("reads the root alone, as before", () => {
		const { index, file } = indexOver(fixture());
		expect(index.fileClassNames).not.toContain("Score");
		expect(index.isFileClassNote("70-79 H/70 M/70.03 Shapes/classes/Score.md")).toBe(false);
		expect(index.getFileClasses(file("70-79 H/75 G/75.11 S/session.md"))).toEqual(["Event/Session"]);
		expect(names(index.getFields(file("70-79 H/75 G/75.11 S/session.md")))).toEqual(["when"]);
		expect(index.errors).toEqual([]);
	});

	it("keeps a parent that names no class in the ancestors, as before; a self-reference gives none", () => {
		const files = fixture();
		files["Classes/Orphan.md"] = { type: "Meta/Fileclass", extends: "Missing" };
		files["Classes/Selfish.md"] = { type: "Meta/Fileclass", extends: "Selfish" };
		for (const enableScopedClasses of [false, true]) {
			const { index } = indexOver(files, { enableScopedClasses });
			expect(index.getAncestors("Orphan")).toEqual(["Missing"]);
			expect(index.getAncestors("Selfish")).toEqual([]);
		}
	});

	it("does not rebuild for a scoped path", () => {
		const { index } = indexOver(fixture());
		expect(index.affectsSchema("Classes/Book.md")).toBe(true);
		expect(index.affectsSchema("70-79 H/70 M/70.03 Shapes/classes/Score.md")).toBe(false);
		expect(index.affectsSchema("70-79 H/70-79 H.md")).toBe(false);
	});
});

describe("scoped classes on", () => {
	const on = { enableScopedClasses: true };

	it("a scope's class shadows the root's for its notes only, and the shadow is reported", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(names(index.getFields(file("70-79 H/75 G/75.11 S/session.md")))).toEqual(["when", "coach"]);
		expect(names(index.getFields(file("Notes/session.md")))).toEqual(["when"]);
		expect(index.errors.some((e) => /Event\/Session in 70-79 H\/70 M\/.* shadows Event\/Session in Classes\/Event\/Session\.md/.test(e))).toBe(true);
	});

	it("extends to the shadowed class: a class never extends itself", () => {
		const { index, file } = indexOver(fixture(), on);
		const fields = index.getFields(file("70-79 H/75 G/75.11 S/session.md"));
		expect(fields.find((f) => f.name === "when")).toBeTruthy();
		// The root's accessors by bare name still mean the root's class.
		expect(index.getAncestors("Event/Session")).toEqual([]);
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
		expect(index.getFileClasses(file("70-79 H/75 G/75.11 S/score.md"))).toEqual(["Score"]);
		expect(index.getFileClasses(file("Notes/score.md"))).toEqual([]);
		// A root class's tag still reaches a note inside a scope.
		expect(index.getFileClasses(file("70-79 H/75 G/75.11 S/book.md"))).toEqual(["Book"]);
	});

	it("a name given twice in one scope binds neither, and is reported", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(index.getFileClasses(file("50 Dup/x.md"))).toEqual([]);
		expect(index.errors.some((e) => /gives the class X twice/.test(e))).toBe(true);
	});

	it("the folder note of a classes folder is not a class; a stray is reported", () => {
		const { index } = indexOver(fixture(), on);
		expect(index.isFileClassNote("70-79 H/70 M/70.03 Shapes/classes/classes.md")).toBe(false);
		expect(index.isFileClassNote("70-79 H/70 M/70.03 Shapes/classes/stray.md")).toBe(false);
		expect(index.errors.some((e) => e.includes("classes/classes.md"))).toBe(false);
		expect(index.errors.some((e) => e.includes("classes/stray.md") && /binds nothing/.test(e))).toBe(true);
		expect(index.isFileClassNote("70-79 H/70 M/70.03 Shapes/classes/Score.md")).toBe(true);
	});

	it("a class note in a scoped folder carries no global class", () => {
		const files = fixture();
		files["Classes/Global.md"] = { type: "Meta/Fileclass", fields: [field("g")] };
		const { index, file } = indexOver(files, { ...on, globalFileClass: "Global" });
		expect(index.getFileClasses(file("70-79 H/70 M/70.03 Shapes/classes/Score.md"))).not.toContain("Global");
		expect(index.getFileClasses(file("40 F/ledger.md"))).toContain("Global");
	});

	it("a subfolder's folder note is not a stray, and no file of a scoped folder carries the global class", () => {
		const files = fixture();
		files["70-79 H/70 M/70.03 Shapes/classes/Event/Event.md"] = { type: "Meta/Collection" };
		files["Classes/Global.md"] = { type: "Meta/Fileclass", fields: [field("g")] };
		const { index, file } = indexOver(files, { ...on, globalFileClass: "Global" });
		expect(index.errors.some((e) => e.includes("classes/Event/Event.md"))).toBe(false);
		expect(index.getFileClasses(file("70-79 H/70 M/70.03 Shapes/classes/stray.md"))).not.toContain("Global");
		expect(index.getFileClasses(file("70-79 H/70 M/70.03 Shapes/classes/Event/Event.md"))).not.toContain("Global");
	});

	it("a shared folder belongs to the management category even when it has no up yet", () => {
		const files = fixture();
		// The category loses its up, so its chain is now shorter than its area's, and it names a
		// second classes folder that only its own chain reaches.
		files["70-79 H/70 M/70 M.md"] = {
			type: "Meta/Scope/Category",
			classes: ["70-79 H/70 M/70.03 Shapes/classes", "70-79 H/70 M/extra"],
		};
		files["70-79 H/70 M/extra/Base.md"] = { type: "Meta/Fileclass", fields: [field("base")] };
		// A class of the shared folder extends Base: it resolves only if the category owns the
		// shared folder. Owned by the area (the longer chain), Base would be out of reach.
		files["70-79 H/70 M/70.03 Shapes/classes/Recital.md"] = {
			type: "Meta/Fileclass",
			extends: "Base",
			fields: [field("played")],
		};
		files["70-79 H/70 M/recital.md"] = { type: "Recital" };
		const { index, file } = indexOver(files, on);
		expect(names(index.getFields(file("70-79 H/70 M/recital.md")))).toEqual(["base", "played"]);
		// The area's notes still see the shared folder's classes.
		expect(index.getFileClasses(file("70-79 H/75 G/75.11 S/score.md"))).toEqual(["Score"]);
	});

	it("rebuilds for a scope note, a scoped class, and a new classes folder", () => {
		const { index } = indexOver(fixture(), on);
		expect(index.affectsSchema("70-79 H/70-79 H.md")).toBe(true);
		expect(index.affectsSchema("70-79 H/70 M/70.03 Shapes/classes/Score.md")).toBe(true);
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
		delete files["70-79 H/70 M/70.03 Shapes/classes/Event/Session.md"];
		files["Classes/Global.md"] = { type: "Meta/Fileclass", fields: [field("g")] };
		const off = snapshot(files, false, "Global");
		const on = snapshot(files, true, "Global");
		const scopedNames = ["Score", "Ledger", "X"];
		// The scoped classes folders become class folders when the setting is on (their files carry
		// no global class, as the root folder's never did), so the comparison is over every other note.
		const scopedFolders = ["70-79 H/70 M/70.03 Shapes/classes/", "40 F/40.03 Shapes/classes/", "50 Dup/a/", "50 Dup/b/"];
		for (const p of Object.keys(on)) {
			if (scopedFolders.some((f) => p.startsWith(f))) continue;
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
			if (p.startsWith("70-79 H/") || p.startsWith("40 F/") || p.startsWith("50 Dup/")) continue;
			expect(on[p], p).toEqual(off[p]);
		}
	});
});
