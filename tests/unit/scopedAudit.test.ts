/*
 * The audit and the log with scoped classes (§10.3): a class is named with its file when a name is
 * not unique, so each class's problems are logged and resolved on their own, and the log reopens
 * the right one.
 */
import { describe, expect, it } from "vitest";

import type FileclassPlugin from "../../main";
import { classRef, parseClassRef } from "../../src/schema/classRef";
import { diffFindings, fingerprint } from "../../src/schema/schemaAudit";
import { auditSchemas } from "../../src/schema/schemaAuditRun";
import { fixture, indexOver } from "./scopedFixture";

const SCOPED_SESSION = "70-79 H/70 M/70.03 Shapes/classes/Event/Session.md";

function audit(files: ReturnType<typeof fixture>, enableScopedClasses = true) {
	const { index, app } = indexOver(files, { enableScopedClasses });
	return auditSchemas({ app, index } as unknown as FileclassPlugin);
}

describe("classRef", () => {
	it("a root class is its name; a scoped one carries its file, and parses back", () => {
		expect(classRef("Score", "Classes/Score.md", "")).toBe("Score");
		const ref = classRef("Event/Session", SCOPED_SESSION, "70-79 H/70 M/70 M.md");
		expect(ref).toBe(`Event/Session @ ${SCOPED_SESSION}`);
		expect(parseClassRef(ref)).toEqual({ name: "Event/Session", path: SCOPED_SESSION });
		expect(parseClassRef("Score")).toEqual({ name: "Score" });
		// A folder may hold the separator; a class name rarely does, so the first one splits.
		expect(parseClassRef("Score @ Clients @ Acme/classes/Score.md")).toEqual({
			name: "Score",
			path: "Clients @ Acme/classes/Score.md",
		});
	});
});

describe("the audit over scoped classes", () => {
	it("two classes of one name with one broken path are two findings, two fingerprints", () => {
		const files = fixture();
		files["Classes/Event/Session.md"] = { ...files["Classes/Event/Session.md"], baseFile: "Gone/x.base" };
		files[SCOPED_SESSION] = { ...files[SCOPED_SESSION], baseFile: "Gone/x.base" };
		const found = audit(files).filter((f) => f.value === "Gone/x.base");
		expect(found.map((f) => f.fileClass).sort()).toEqual(["Event/Session", `Event/Session @ ${SCOPED_SESSION}`]);
		expect(new Set(found.map(fingerprint)).size).toBe(2);
	});

	it("with the setting off, a finding names its class as before", () => {
		const files = fixture();
		files["Classes/Event/Session.md"] = { ...files["Classes/Event/Session.md"], baseFile: "Gone/x.base" };
		expect(audit(files, false).filter((f) => f.value === "Gone/x.base").map((f) => f.fileClass)).toEqual([
			"Event/Session",
		]);
	});

	it("a scoped class that extends its own name with nothing above is a missing parent", () => {
		const files = fixture();
		files["70-79 H/70 M/70.03 Shapes/classes/Loop.md"] = { type: "Meta/Fileclass", extends: "Loop" };
		const found = audit(files).filter((f) => f.kind === "missing-parent");
		expect(found.map((f) => f.fileClass)).toEqual(["Loop @ 70-79 H/70 M/70.03 Shapes/classes/Loop.md"]);
	});

	it("a shadow that extends what it shadows is not a missing parent", () => {
		expect(audit(fixture()).some((f) => f.kind === "missing-parent" && f.fileClass.startsWith("Event/Session"))).toBe(
			false
		);
	});
});

describe("two files, one name, one scope (ARCHITECTURE.md §10.3)", () => {
	const DUP_A = "50 Dup/a/X.md";
	const DUP_B = "50 Dup/b/X.md";
	const SCOPE = "50 Dup/50 Dup.md";
	const dups = (files: ReturnType<typeof fixture>) => audit(files).filter((f) => f.kind === "duplicate-class");

	it("the index lists the clash once, with its scope and both files", () => {
		const { index } = indexOver(fixture(), { enableScopedClasses: true });
		expect(index.duplicateClasses()).toEqual([{ scopes: [SCOPE], name: "X", paths: [DUP_A, DUP_B] }]);
	});

	it("is one ERROR finding, named with its first file, a class the wrench can open", () => {
		const { index } = indexOver(fixture(), { enableScopedClasses: true });
		const found = dups(fixture());
		expect(found).toHaveLength(1);
		expect(found[0].level).toBe("ERROR");
		expect(found[0].fileClass).toBe(`X @ ${DUP_A}`);
		const ref = parseClassRef(found[0].fileClass);
		expect(ref.path && index.isFileClassNote(ref.path)).toBe(true);
		// What the wrench and the schema editor call: each file of the clash opens as itself.
		for (const p of [DUP_A, DUP_B]) {
			expect(index.getFileClassFile("X", p)?.path).toBe(p);
			expect(index.getFileClass("X", p)).toBe(index.getFileClassByPath(p));
		}
		// A note of the scope still binds neither.
		expect(index.resolveClass("X", "50 Dup/x.md")).toBeUndefined();
		expect(found[0].value).toBe(`${DUP_A}, ${DUP_B} in ${SCOPE}`);
		expect(found[0].consequence).toContain(SCOPE);
	});

	it("a third file is listed, as a new clash", () => {
		const files = fixture();
		files["50 Dup/c/X.md"] = { type: "Meta/Fileclass" };
		files[SCOPE] = { ...files[SCOPE], classes: ["50 Dup/a", "50 Dup/b", "50 Dup/c"] };
		const found = dups(files);
		expect(found).toHaveLength(1);
		expect(found[0].value).toBe(`${DUP_A}, ${DUP_B}, 50 Dup/c/X.md in ${SCOPE}`);
	});

	it("a child scope that inherits the clash does not report it again", () => {
		const files = fixture();
		files["50 Dup/51 Kid/51 Kid.md"] = { type: "Meta/Scope/Category", up: "[[50 Dup]]" };
		files["50 Dup/51 Kid/y.md"] = { type: "X" };
		const { index, file } = indexOver(files, { enableScopedClasses: true });
		expect(index.getFileClasses(file("50 Dup/51 Kid/y.md"))).toEqual([]);
		expect(dups(files)).toHaveLength(1);
	});

	it("scope notes that share or overlap the clashing folders report it once, naming every scope it breaks", () => {
		const files = fixture();
		files["50 Dup/55 Sub/55 Sub.md"] = { type: "Meta/Scope/Category", up: "[[50 Dup]]", classes: ["50 Dup/b", "50 Dup/a"] };
		files["50 Dup/56 Over/56 Over.md"] = { type: "Meta/Scope/Category", classes: ["50 Dup/a", "50 Dup/b", "50 Dup/d"] };
		const { index } = indexOver(files, { enableScopedClasses: true }, ["50 Dup/d"]);
		const all = index.duplicateClasses();
		expect(all).toHaveLength(1);
		// Each of the three scope notes gives the name twice in its own layer, so each one's notes break.
		expect(all[0].scopes).toEqual([SCOPE, "50 Dup/55 Sub/55 Sub.md", "50 Dup/56 Over/56 Over.md"]);
		const found = dups(files);
		expect(found).toHaveLength(1);
		expect(found[0].consequence).toContain("50 Dup/56 Over/56 Over.md");
	});

	it("a scope that names another scope's folder plus its own is the scope named, not the folder's owner", () => {
		const files = fixture();
		const BOR = "60 Bor/60 Bor.md";
		files[BOR] = { type: "Meta/Scope/Category", classes: ["50 Dup/a", "60 Bor/c"] };
		files["60 Bor/c/X.md"] = { type: "Meta/Fileclass" };
		files["60 Bor/z.md"] = { type: "X" };
		const { index, file } = indexOver(files, { enableScopedClasses: true });
		expect(index.getFileClasses(file("60 Bor/z.md"))).toEqual([]);
		const mine = index.duplicateClasses().filter((d) => d.paths.includes("60 Bor/c/X.md"));
		// 50 Dup owns 50 Dup/a and its own clash is {a, b}; the clash {a, c} breaks 60 Bor's notes only.
		expect(mine).toEqual([{ scopes: [BOR], name: "X", paths: [DUP_A, "60 Bor/c/X.md"] }]);
		const found = dups(files).find((f) => f.value.includes("60 Bor/c/X.md"));
		expect(found?.consequence).toContain(BOR);
		expect(found?.consequence).not.toContain(SCOPE);
		// Labelled with the file 60 Bor owns, not the borrowed one, so it differs from 50 Dup's own clash.
		expect(found?.fileClass).toBe("X @ 60 Bor/c/X.md");
		expect(index.getFileClassFile("X", "60 Bor/c/X.md")?.path).toBe("60 Bor/c/X.md");
	});

	it("a child that names some of its parent's clashing folders adds no second clash, and binds its own", () => {
		const files = fixture();
		files["50 Dup/c/X.md"] = { type: "Meta/Fileclass" };
		files[SCOPE] = { ...files[SCOPE], classes: ["50 Dup/a", "50 Dup/b", "50 Dup/c"] };
		files["50 Dup/55 Sub/55 Sub.md"] = { type: "Meta/Scope/Category", up: "[[50 Dup]]", classes: ["50 Dup/a"] };
		files["50 Dup/55 Sub/y.md"] = { type: "X" };
		const { index, file } = indexOver(files, { enableScopedClasses: true });
		// The child's chain reads b and c in its parent's layer: a subset of the parent's clash, not a new one.
		expect(index.duplicateClasses()).toEqual([{ scopes: [SCOPE], name: "X", paths: [DUP_A, DUP_B, "50 Dup/c/X.md"] }]);
		expect(index.getFileClasses(file("50 Dup/55 Sub/y.md"))).toEqual(["X"]);
		expect(index.getFileClasses(file("50 Dup/x.md"))).toEqual([]);
		expect(index.errors.filter((e) => /more than once/.test(e))).toHaveLength(1);
		const found = dups(files);
		expect(found).toHaveLength(1);
		expect(found[0].consequence).toContain("unless a nearer scope gives the name");
	});

	it("a scope that starts giving the clash too logs it again, naming both", () => {
		const logged = (fs: ReturnType<typeof dups>) =>
			fs.map((f) => ({ event: `schema.${f.kind}`, details: { fingerprint: fingerprint(f) } }));
		const before = dups(fixture());
		const files = fixture();
		files["60 Two/60 Two.md"] = { type: "Meta/Scope/Category", classes: ["50 Dup/a", "50 Dup/b"] };
		const after = dups(files);
		expect(after).toHaveLength(1);
		expect(after[0].value).toBe(`${DUP_A}, ${DUP_B} in ${SCOPE}, 60 Two/60 Two.md`);
		const diff = diffFindings(logged(before), after);
		expect(diff.fresh).toEqual(after);
		expect(diff.resolved).toEqual([fingerprint(before[0])]);
	});

	it("paths sort by code unit, whatever the locale would say", () => {
		const files = fixture();
		// Code-unit order puts upper case before lower case; a locale order would not.
		files["50 Dup/50 Dup.md"] = { ...files["50 Dup/50 Dup.md"], classes: ["50 Dup/a", "50 Dup/b", "50 Dup/B"] };
		files["50 Dup/B/X.md"] = { type: "Meta/Fileclass" };
		const { index } = indexOver(files, { enableScopedClasses: true });
		expect(index.duplicateClasses()[0].paths).toEqual(["50 Dup/B/X.md", DUP_A, DUP_B]);
	});

	it("through the log diff: a changed clash is resolved and fresh, a fixed one is resolved", () => {
		const logged = (fs: ReturnType<typeof dups>) =>
			fs.map((f) => ({ event: `schema.${f.kind}`, details: { fingerprint: fingerprint(f) } }));
		const before = dups(fixture());
		const three = fixture();
		three["50 Dup/c/X.md"] = { type: "Meta/Fileclass" };
		three[SCOPE] = { ...three[SCOPE], classes: ["50 Dup/a", "50 Dup/b", "50 Dup/c"] };
		const after = dups(three);
		const changed = diffFindings(logged(before), after);
		expect(changed.fresh).toEqual(after);
		expect(changed.resolved).toEqual([fingerprint(before[0])]);
		// The same clash again is not logged twice.
		expect(diffFindings(logged(before), before).fresh).toEqual([]);
		const fixed = fixture();
		fixed[SCOPE] = { ...fixed[SCOPE], classes: ["50 Dup/a"] };
		const gone = diffFindings(logged(before), dups(fixed));
		expect(gone.fresh).toEqual([]);
		expect(gone.resolved).toEqual([fingerprint(before[0])]);
	});

	it("a root class of the same name binds outside the clashing scope, never inside it (pick A)", () => {
		const files = fixture();
		files["Classes/X.md"] = { type: "Meta/Fileclass" };
		files["Notes/x.md"] = { type: "X" };
		const { index, file } = indexOver(files, { enableScopedClasses: true });
		expect(index.getFileClasses(file("50 Dup/x.md"))).toEqual([]);
		expect(index.getFileClasses(file("Notes/x.md"))).toEqual(["X"]);
	});

	it("nothing is reported with the setting off", () => {
		expect(audit(fixture(), false).some((f) => f.kind === "duplicate-class")).toBe(false);
	});
});
