/*
 * The context on the index's class accessors (§10.3, PR 2): a class name means the nearest class
 * that gives it up a context's scope chain, and no context means the root's — so every caller
 * that passes a bare name reads what it read before.
 */
import { describe, expect, it } from "vitest";

import { fixture, indexOver } from "./scopedFixture";

const on = { enableScopedClasses: true };
const names = (fields: { name: string }[]) => fields.map((f) => f.name);

const VISIT_IN_85 = "80-89 D/85 E/85.11 V/visit.md";
const SCOPED_VISIT = "80-89 D/80 M/80.03 Shapes/classes/Event/Visit.md";
const CASE = "80-89 D/80 M/80.03 Shapes/classes/Case.md";

describe("a bare name means the root", () => {
	it("reads the root's class, scoped classes on or off", () => {
		for (const enableScopedClasses of [false, true]) {
			const { index } = indexOver(fixture(), { enableScopedClasses });
			expect(names(index.getResolvedFields("Event/Visit"))).toEqual(["when"]);
			expect(index.resolveClass("Event/Visit")).toBe("Classes/Event/Visit.md");
			expect(index.getFileClassFile("Event/Visit")?.path).toBe("Classes/Event/Visit.md");
			expect(index.getAncestors("Event/Visit")).toEqual([]);
			expect(index.getFileClass("Case")).toBeUndefined();
		}
	});

	it("with the setting off, every context means the root", () => {
		const { index, file } = indexOver(fixture());
		expect(index.scopeOf(file(VISIT_IN_85))).toBe("");
		expect(index.chainOf(file(VISIT_IN_85))).toEqual([""]);
		expect(index.getFileClass("Case", file(VISIT_IN_85))).toBeUndefined();
		expect(names(index.getResolvedFields("Event/Visit", file(VISIT_IN_85)))).toEqual(["when"]);
		expect(index.fileClassNamesFor(file(VISIT_IN_85))).toEqual(index.fileClassNames);
		expect(index.allClasses().map((c) => c.scope)).toEqual(index.fileClassNames.map(() => ""));
	});
});

describe("a scoped name resolves with a note's context, not without", () => {
	it("a scope-only class", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(index.getFileClass("Case")).toBeUndefined();
		expect(index.getFileClass("Case", file(VISIT_IN_85))?.fields.map((f) => f.name)).toEqual(["docket"]);
		expect(index.getFileClassFile("Case", file(VISIT_IN_85))?.path).toBe(CASE);
		// The root fallback is the root's: a scoped name is never guessed into the root folder.
		expect(index.getFileClassFile("Case")).toBeNull();
		expect(index.getFileClass("Case", "Notes/case.md")).toBeUndefined();
	});

	it("a shadow: the note's scope reads its own class, the root reads the root's", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(names(index.getResolvedFields("Event/Visit", file(VISIT_IN_85)))).toEqual(["when", "supervisor"]);
		expect(names(index.getResolvedFields("Event/Visit", "Notes/visit.md"))).toEqual(["when"]);
		expect(index.getAncestors("Event/Visit", file(VISIT_IN_85))).toEqual(["Event/Visit"]);
		expect(index.getAncestorPaths("Event/Visit", file(VISIT_IN_85))).toEqual(["Classes/Event/Visit.md"]);
	});

	it("a class file is its own context, wherever it sits", () => {
		const { index } = indexOver(fixture(), on);
		expect(index.resolveClass("Event/Visit", SCOPED_VISIT)).toBe(SCOPED_VISIT);
		expect(index.resolveClass("Event/Visit", "Classes/Event/Visit.md")).toBe("Classes/Event/Visit.md");
		// What its `extends` names: from its own scope upward, never itself.
		expect(index.resolveParent("Event/Visit", SCOPED_VISIT)).toBe("Classes/Event/Visit.md");
		expect(index.resolveParent("Event/Visit", "Classes/Event/Visit.md")).toBeUndefined();
	});

	it("an icon is the class's own, read from the context", () => {
		const files = fixture();
		files[CASE] = { ...files[CASE], icon: "gavel" };
		const { index, file } = indexOver(files, on);
		expect(index.resolveIcon("Case", file(VISIT_IN_85))).toBe("gavel");
		expect(index.resolveIcon("Case")).toBe(index.resolveIcon("Missing"));
	});

	it("a scope, a folder or a scope note path is a context too; an unknown path is the root", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(index.scopeOf(file(VISIT_IN_85))).toBe("80-89 D/85 E/85 E.md");
		expect(index.scopeOf("80-89 D/85 E/85.11 V")).toBe("80-89 D/85 E/85 E.md");
		expect(index.scopeOf("80-89 D/80-89 D.md")).toBe("80-89 D/80-89 D.md");
		expect(index.scopeOf(CASE)).toBe("80-89 D/80 M/80 M.md");
		expect(index.scopeOf("Notes/book.md")).toBe("");
		expect(index.scopeOf("Nowhere/at/all.md")).toBe("");
		expect(index.knowsContext("Nowhere/at/all.md")).toBe(false);
		expect(index.knowsContext("80-89 D/85 E")).toBe(true);
		expect(index.chainOf(file(VISIT_IN_85))).toEqual([
			"80-89 D/85 E/85 E.md",
			"80-89 D/80-89 D.md",
			"Top.md",
			"",
		]);
	});
});

describe("which classes a note sees", () => {
	it("a scope-only class is listed for a note in its scope and not outside it", () => {
		const { index, file } = indexOver(fixture(), on);
		const inside = index.fileClassNamesFor(file(VISIT_IN_85));
		expect(inside).toContain("Case");
		expect(inside.filter((n) => n === "Event/Visit")).toHaveLength(1);
		expect(inside).toContain("Book");
		expect(index.fileClassNamesFor(file("Notes/book.md"))).not.toContain("Case");
		expect(index.fileClassNamesFor(file("Notes/book.md"))).toEqual(index.fileClassNames);
		// A name two files of one scope give is listed nowhere: it binds nothing.
		expect(index.fileClassNamesFor(file("50 Dup/x.md"))).not.toContain("X");
	});

	it("every class, root and scoped, with its file and scope; a doubled name is left out", () => {
		const { index } = indexOver(fixture(), on);
		const all = index.allClasses();
		expect(all).toContainEqual({ name: "Case", path: CASE, scope: "80-89 D/80 M/80 M.md" });
		expect(all).toContainEqual({ name: "Event/Visit", path: SCOPED_VISIT, scope: "80-89 D/80 M/80 M.md" });
		expect(all).toContainEqual({ name: "Event/Visit", path: "Classes/Event/Visit.md", scope: "" });
		expect(all.some((c) => c.name === "X")).toBe(false);
	});

	it("a note carries the class a name means from a context only when its own scope means the same file", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(index.bindsClass(file("Notes/visit.md"), "Event/Visit")).toBe(true);
		expect(index.bindsClass(file(VISIT_IN_85), "Event/Visit")).toBe(false);
		expect(index.bindsClass(file(VISIT_IN_85), "Event/Visit", SCOPED_VISIT)).toBe(true);
		expect(index.bindsClass(file("Notes/visit.md"), "Event/Visit", SCOPED_VISIT)).toBe(false);
	});

	it("a field knows the class file that declares it", () => {
		const { index, file } = indexOver(fixture(), on);
		const owners = index.getFields(file(VISIT_IN_85)).map((f) => [f.name, f.fileClassPath]);
		expect(owners).toEqual([
			["when", "Classes/Event/Visit.md"],
			["supervisor", SCOPED_VISIT],
		]);
	});
});

describe("where a new class goes", () => {
	it("the root's folder, a category's classes folder, an area's management category's", () => {
		const { index } = indexOver(fixture(), on);
		expect(index.classesFolderForNewClass("")).toBe("Classes");
		expect(index.classesFolderForNewClass("40 F/40 F.md")).toBe("40 F/40.03 Shapes/classes");
		expect(index.classesFolderForNewClass("80-89 D/80-89 D.md")).toBe("80-89 D/80 M/80.03 Shapes/classes");
	});

	it("a classes folder the pattern names but that does not exist yet", () => {
		const files = fixture();
		files["30 New/30 New.md"] = { type: "Meta/Scope/Category" };
		files["30 New/30.03 Shapes/30.03 Shapes.md"] = { type: "Meta/Slot/Shapes" };
		files["31 Bare/31 Bare.md"] = { type: "Meta/Scope/Category" };
		const { index } = indexOver(files, on);
		expect(index.classesFolderForNewClass("30 New/30 New.md")).toBe("30 New/30.03 Shapes/classes");
		// No .03 slot: nowhere the pattern could name.
		expect(index.classesFolderForNewClass("31 Bare/31 Bare.md")).toBeUndefined();
	});
});
