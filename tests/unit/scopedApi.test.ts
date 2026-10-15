/*
 * The API with scoped classes (§10.3, API 1.2): an optional `scope` on the calls that take a class
 * name. No scope means the root, as before 1.2; a scope that names nothing is refused.
 */
import { describe, expect, it, vi } from "vitest";

// The two UI modules the API imports for its interactive calls; neither runs in these tests.
vi.mock("../../src/ui/fileClassSchemaModal", () => ({ openFileClassSchema: vi.fn() }));
vi.mock("../../src/fields/fieldActions", () => ({ clearField: vi.fn() }));

import type FileclassPlugin from "../../main";
import { API_VERSION, createFileclassApi } from "../../src/api/fileclassApi";
import { openFileClassSchema } from "../../src/ui/fileClassSchemaModal";
import { fixture, indexOver } from "./scopedFixture";

const SESSION_IN_75 = "70-79 H/75 G/75.11 S/session.md";
const SCOPED_SESSION = "70-79 H/70 M/70.03 Shapes/classes/Event/Session.md";
const CASE = "70-79 H/70 M/70.03 Shapes/classes/Score.md";

function apiOver(enableScopedClasses: boolean) {
	const { index, app, settings } = indexOver(fixture(), { enableScopedClasses });
	const plugin = { app, index, settings, basesAvailable: false } as unknown as FileclassPlugin;
	return createFileclassApi(plugin);
}

describe("API 1.2", () => {
	it("is version 1.2", () => {
		expect(API_VERSION).toBe("1.2");
	});

	it("a bare name means the root, on and off", async () => {
		for (const on of [false, true]) {
			const api = apiOver(on);
			const schema = await api.getSchema("Event/Session");
			expect(schema?.path).toBe("Classes/Event/Session.md");
			expect(schema?.scope).toBe("");
			expect(schema?.fields.map((f) => f.name)).toEqual(["when"]);
			expect(await api.getSchema("Score")).toBeNull();
			const list = await api.listFileClasses();
			expect(list.map((c) => c.name)).not.toContain("Score");
			expect(list.every((c) => c.scope === "" && c.path.startsWith("Classes/"))).toBe(true);
		}
	});

	it("a scoped name resolves with a scope and not without", async () => {
		const api = apiOver(true);
		const schema = await api.getSchema("Event/Session", SESSION_IN_75);
		expect(schema?.path).toBe(SCOPED_SESSION);
		expect(schema?.scope).toBe("70-79 H/70 M/70 M.md");
		expect(schema?.ancestors).toEqual(["Event/Session"]);
		expect(schema?.fields.map((f) => f.name)).toEqual(["when", "coach"]);
		expect((await api.getSchema("Score", "70-79 H/75 G"))?.path).toBe(CASE);
	});

	it("listFileClasses(scope) lists a scope-only class for that scope and not outside it", async () => {
		const api = apiOver(true);
		const inside = await api.listFileClasses(SESSION_IN_75);
		expect(inside.find((c) => c.name === "Score")).toMatchObject({ path: CASE, scope: "70-79 H/70 M/70 M.md" });
		expect(inside.find((c) => c.name === "Event/Session")?.path).toBe(SCOPED_SESSION);
		expect((await api.listFileClasses("Notes/book.md")).map((c) => c.name)).not.toContain("Score");
	});

	it("listNotes picks the class the scope means: a shadow's notes are not the root class's", async () => {
		const api = apiOver(true);
		expect((await api.listNotes("Event/Session", { columns: [] })).map((r) => r.path)).toEqual(["Notes/session.md"]);
		expect(
			(await api.listNotes("Event/Session", { columns: [], scope: SCOPED_SESSION })).map((r) => r.path)
		).toEqual([SESSION_IN_75]);
		expect((await api.listNotes("Score", { columns: [], scope: "70-79 H" })).map((r) => r.path)).toEqual([
			"70-79 H/75 G/75.11 S/score.md",
		]);
	});

	it("with the setting off, listNotes is what it was", async () => {
		const api = apiOver(false);
		expect((await api.listNotes("Event/Session", { columns: [] })).map((r) => r.path).sort()).toEqual([
			SESSION_IN_75,
			"Notes/session.md",
		]);
	});

	it("explain gives each bound class's file", async () => {
		const api = apiOver(true);
		expect((await api.explain(SESSION_IN_75))?.classPaths).toEqual([SCOPED_SESSION]);
		expect((await api.explain("Notes/session.md"))?.classPaths).toEqual(["Classes/Event/Session.md"]);
	});

	it("validate --fileclass reads the name from its scope", async () => {
		const api = apiOver(true);
		// Every field is Input and empty: valid. The point is which notes are asked, and that a
		// scope-only name with its scope is not an unknown class.
		await expect(api.validate({ fileClass: "Score", scope: "70-79 H" })).resolves.toEqual([]);
	});

	it("a scope that names nothing is refused: thrown by a read, returned by a write", async () => {
		const api = apiOver(true);
		await expect(api.getSchema("Score", "No/such/place")).rejects.toThrow(/no scope, note or folder/);
		await expect(api.listNotes("Score", { scope: "No/such/place" })).rejects.toThrow(/no scope/);
		const result = await api.setValueWhere("Score", "tempo", "1", undefined, "No/such/place");
		expect(result.ok).toBe(false);
		expect(result.changed).toBe(0);
		expect(result.errors[0].message).toMatch(/no scope, note or folder/);
	});

	it("openSchema opens the class the scope means", async () => {
		const api = apiOver(true);
		expect((await api.openSchema("Score")).ok).toBe(false);
		expect((await api.openSchema("Score", "70-79 H")).ok).toBe(true);
		expect(vi.mocked(openFileClassSchema)).toHaveBeenLastCalledWith(expect.anything(), "Score", undefined, "70-79 H");
	});
});
