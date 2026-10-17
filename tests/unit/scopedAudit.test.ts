/*
 * The audit and the log with scoped classes (§10.3): a class is named with its file when a name is
 * not unique, so each class's problems are logged and resolved on their own, and the log reopens
 * the right one.
 */
import { describe, expect, it } from "vitest";

import type FileclassPlugin from "../../main";
import { classRef, parseClassRef } from "../../src/schema/classRef";
import { fingerprint } from "../../src/schema/schemaAudit";
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

describe("two files, one name, one scope (01.12 rule 1k)", () => {
	const DUP_A = "50 Dup/a/X.md";
	const DUP_B = "50 Dup/b/X.md";

	it("the index lists the clash once, with its scope and both files", () => {
		const { index } = indexOver(fixture(), { enableScopedClasses: true });
		expect(index.duplicateClasses()).toEqual([{ scope: "50 Dup/50 Dup.md", name: "X", paths: [DUP_A, DUP_B] }]);
	});

	it("is one ERROR finding, named with its first file, its value both files", () => {
		const found = audit(fixture()).filter((f) => f.kind === "duplicate-class");
		expect(found).toHaveLength(1);
		expect(found[0].level).toBe("ERROR");
		expect(found[0].fileClass).toBe(`X @ ${DUP_A}`);
		expect(found[0].value).toBe(`${DUP_A}, ${DUP_B}`);
		expect(found[0].consequence).toMatch(/neither file binds/);
	});

	it("a child scope that inherits the clash does not report it again", () => {
		const files = fixture();
		files["50 Dup/51 Kid/51 Kid.md"] = { type: "Meta/Scope/Category", up: "[[50 Dup]]" };
		files["50 Dup/51 Kid/y.md"] = { type: "X" };
		const { index, file } = indexOver(files, { enableScopedClasses: true });
		expect(index.getFileClasses(file("50 Dup/51 Kid/y.md"))).toEqual([]);
		expect(audit(files).filter((f) => f.kind === "duplicate-class")).toHaveLength(1);
	});

	it("a root class of the same name does not bind in the clashing scope (pick A)", () => {
		const files = fixture();
		files["Classes/X.md"] = { type: "Meta/Fileclass" };
		const { index, file } = indexOver(files, { enableScopedClasses: true });
		expect(index.getFileClasses(file("50 Dup/x.md"))).toEqual([]);
		expect(index.getFileClasses(file("Notes/score.md"))).not.toContain("X");
	});

	it("nothing is reported with the setting off", () => {
		expect(audit(fixture(), false).some((f) => f.kind === "duplicate-class")).toBe(false);
	});
});
