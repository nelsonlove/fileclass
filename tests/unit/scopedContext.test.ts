/*
 * The context on the index's class accessors (§10.3, PR 2): a class name means the nearest class
 * that gives it up a context's scope chain, and no context means the root's — so every caller
 * that passes a bare name reads what it read before.
 */
import { describe, expect, it } from "vitest";

import { fixture, indexOver } from "./scopedFixture";

const on = { enableScopedClasses: true };
const names = (fields: { name: string }[]) => fields.map((f) => f.name);

const SESSION_IN_75 = "70-79 H/75 G/75.11 S/session.md";
const SCOPED_SESSION = "70-79 H/70 M/70.03 Shapes/classes/Event/Session.md";
const CASE = "70-79 H/70 M/70.03 Shapes/classes/Score.md";

describe("a bare name means the root", () => {
	it("reads the root's class, scoped classes on or off", () => {
		for (const enableScopedClasses of [false, true]) {
			const { index } = indexOver(fixture(), { enableScopedClasses });
			expect(names(index.getResolvedFields("Event/Session"))).toEqual(["when"]);
			expect(index.resolveClass("Event/Session")).toBe("Classes/Event/Session.md");
			expect(index.getFileClassFile("Event/Session")?.path).toBe("Classes/Event/Session.md");
			expect(index.getAncestors("Event/Session")).toEqual([]);
			expect(index.getFileClass("Score")).toBeUndefined();
		}
	});

	it("with the setting off, every context means the root", () => {
		const { index, file } = indexOver(fixture());
		expect(index.scopeOf(file(SESSION_IN_75))).toBe("");
		expect(index.chainOf(file(SESSION_IN_75))).toEqual([""]);
		expect(index.getFileClass("Score", file(SESSION_IN_75))).toBeUndefined();
		expect(names(index.getResolvedFields("Event/Session", file(SESSION_IN_75)))).toEqual(["when"]);
		expect(index.fileClassNamesFor(file(SESSION_IN_75))).toEqual(index.fileClassNames);
		expect(index.allClasses().map((c) => c.scope)).toEqual(index.fileClassNames.map(() => ""));
	});
});

describe("a scoped name resolves with a note's context, not without", () => {
	it("a scope-only class", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(index.getFileClass("Score")).toBeUndefined();
		expect(index.getFileClass("Score", file(SESSION_IN_75))?.fields.map((f) => f.name)).toEqual(["tempo"]);
		expect(index.getFileClassFile("Score", file(SESSION_IN_75))?.path).toBe(CASE);
		// The root fallback is the root's: a scoped name is never guessed into the root folder.
		expect(index.getFileClassFile("Score")).toBeNull();
		expect(index.getFileClass("Score", "Notes/score.md")).toBeUndefined();
	});

	it("a shadow: the note's scope reads its own class, the root reads the root's", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(names(index.getResolvedFields("Event/Session", file(SESSION_IN_75)))).toEqual(["when", "coach"]);
		expect(names(index.getResolvedFields("Event/Session", "Notes/session.md"))).toEqual(["when"]);
		expect(index.getAncestors("Event/Session", file(SESSION_IN_75))).toEqual(["Event/Session"]);
		expect(index.getAncestorPaths("Event/Session", file(SESSION_IN_75))).toEqual(["Classes/Event/Session.md"]);
	});

	it("a class file is its own context, wherever it sits", () => {
		const { index } = indexOver(fixture(), on);
		expect(index.resolveClass("Event/Session", SCOPED_SESSION)).toBe(SCOPED_SESSION);
		expect(index.resolveClass("Event/Session", "Classes/Event/Session.md")).toBe("Classes/Event/Session.md");
		// What its `extends` names: from its own scope upward, never itself.
		expect(index.resolveParent("Event/Session", SCOPED_SESSION)).toBe("Classes/Event/Session.md");
		expect(index.resolveParent("Event/Session", "Classes/Event/Session.md")).toBeUndefined();
	});

	it("an icon is the class's own, read from the context", () => {
		const files = fixture();
		files[CASE] = { ...files[CASE], icon: "gavel" };
		const { index, file } = indexOver(files, on);
		expect(index.resolveIcon("Score", file(SESSION_IN_75))).toBe("gavel");
		expect(index.resolveIcon("Score")).toBe(index.resolveIcon("Missing"));
	});

	it("a scope, a folder or a scope note path is a context too; an unknown path is the root", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(index.scopeOf(file(SESSION_IN_75))).toBe("70-79 H/75 G/75 G.md");
		expect(index.scopeOf("70-79 H/75 G/75.11 S")).toBe("70-79 H/75 G/75 G.md");
		expect(index.scopeOf("70-79 H/70-79 H.md")).toBe("70-79 H/70-79 H.md");
		expect(index.scopeOf(CASE)).toBe("70-79 H/70 M/70 M.md");
		expect(index.scopeOf("Notes/book.md")).toBe("");
		expect(index.scopeOf("Nowhere/at/all.md")).toBe("");
		expect(index.knowsContext("Nowhere/at/all.md")).toBe(false);
		expect(index.knowsContext("70-79 H/75 G")).toBe(true);
		expect(index.chainOf(file(SESSION_IN_75))).toEqual([
			"70-79 H/75 G/75 G.md",
			"70-79 H/70-79 H.md",
			"Top.md",
			"",
		]);
	});
});

describe("which classes a note sees", () => {
	it("a scope-only class is listed for a note in its scope and not outside it", () => {
		const { index, file } = indexOver(fixture(), on);
		const inside = index.fileClassNamesFor(file(SESSION_IN_75));
		expect(inside).toContain("Score");
		expect(inside.filter((n) => n === "Event/Session")).toHaveLength(1);
		expect(inside).toContain("Book");
		expect(index.fileClassNamesFor(file("Notes/book.md"))).not.toContain("Score");
		expect(index.fileClassNamesFor(file("Notes/book.md"))).toEqual(index.fileClassNames);
		// A name two files of one scope give is listed nowhere: it binds nothing.
		expect(index.fileClassNamesFor(file("50 Dup/x.md"))).not.toContain("X");
	});

	it("every class, root and scoped, with its file and scope; a doubled name is left out", () => {
		const { index } = indexOver(fixture(), on);
		const all = index.allClasses();
		expect(all).toContainEqual({ name: "Score", path: CASE, scope: "70-79 H/70 M/70 M.md" });
		expect(all).toContainEqual({ name: "Event/Session", path: SCOPED_SESSION, scope: "70-79 H/70 M/70 M.md" });
		expect(all).toContainEqual({ name: "Event/Session", path: "Classes/Event/Session.md", scope: "" });
		expect(all.some((c) => c.name === "X")).toBe(false);
	});

	it("a note carries the class a name means from a context only when its own scope means the same file", () => {
		const { index, file } = indexOver(fixture(), on);
		expect(index.bindsClass(file("Notes/session.md"), "Event/Session")).toBe(true);
		expect(index.bindsClass(file(SESSION_IN_75), "Event/Session")).toBe(false);
		expect(index.bindsClass(file(SESSION_IN_75), "Event/Session", SCOPED_SESSION)).toBe(true);
		expect(index.bindsClass(file("Notes/session.md"), "Event/Session", SCOPED_SESSION)).toBe(false);
	});

	it("a field knows the class file that declares it", () => {
		const { index, file } = indexOver(fixture(), on);
		const owners = index.getFields(file(SESSION_IN_75)).map((f) => [f.name, f.fileClassPath]);
		expect(owners).toEqual([
			["when", "Classes/Event/Session.md"],
			["coach", SCOPED_SESSION],
		]);
	});
});

describe("where a new class goes", () => {
	it("the root's folder, a category's classes folder, an area's management category's", () => {
		const { index } = indexOver(fixture(), on);
		expect(index.classesFolderForNewClass("")).toBe("Classes");
		expect(index.classesFolderForNewClass("40 F/40 F.md")).toBe("40 F/40.03 Shapes/classes");
		expect(index.classesFolderForNewClass("70-79 H/70-79 H.md")).toBe("70-79 H/70 M/70.03 Shapes/classes");
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
