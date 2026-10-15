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

const VISIT_IN_85 = "80-89 D/85 E/85.11 V/visit.md";
const SCOPED_VISIT = "80-89 D/80 M/80.03 Shapes/classes/Event/Visit.md";
const CASE = "80-89 D/80 M/80.03 Shapes/classes/Case.md";

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
			const schema = await api.getSchema("Event/Visit");
			expect(schema?.path).toBe("Classes/Event/Visit.md");
			expect(schema?.scope).toBe("");
			expect(schema?.fields.map((f) => f.name)).toEqual(["when"]);
			expect(await api.getSchema("Case")).toBeNull();
			const list = await api.listFileClasses();
			expect(list.map((c) => c.name)).not.toContain("Case");
			expect(list.every((c) => c.scope === "" && c.path.startsWith("Classes/"))).toBe(true);
		}
	});

	it("a scoped name resolves with a scope and not without", async () => {
		const api = apiOver(true);
		const schema = await api.getSchema("Event/Visit", VISIT_IN_85);
		expect(schema?.path).toBe(SCOPED_VISIT);
		expect(schema?.scope).toBe("80-89 D/80 M/80 M.md");
		expect(schema?.ancestors).toEqual(["Event/Visit"]);
		expect(schema?.fields.map((f) => f.name)).toEqual(["when", "supervisor"]);
		expect((await api.getSchema("Case", "80-89 D/85 E"))?.path).toBe(CASE);
	});

	it("listFileClasses(scope) lists a scope-only class for that scope and not outside it", async () => {
		const api = apiOver(true);
		const inside = await api.listFileClasses(VISIT_IN_85);
		expect(inside.find((c) => c.name === "Case")).toMatchObject({ path: CASE, scope: "80-89 D/80 M/80 M.md" });
		expect(inside.find((c) => c.name === "Event/Visit")?.path).toBe(SCOPED_VISIT);
		expect((await api.listFileClasses("Notes/book.md")).map((c) => c.name)).not.toContain("Case");
	});

	it("listNotes picks the class the scope means: a shadow's notes are not the root class's", async () => {
		const api = apiOver(true);
		expect((await api.listNotes("Event/Visit", { columns: [] })).map((r) => r.path)).toEqual(["Notes/visit.md"]);
		expect(
			(await api.listNotes("Event/Visit", { columns: [], scope: SCOPED_VISIT })).map((r) => r.path)
		).toEqual([VISIT_IN_85]);
		expect((await api.listNotes("Case", { columns: [], scope: "80-89 D" })).map((r) => r.path)).toEqual([
			"80-89 D/85 E/85.11 V/case.md",
		]);
	});

	it("with the setting off, listNotes is what it was", async () => {
		const api = apiOver(false);
		expect((await api.listNotes("Event/Visit", { columns: [] })).map((r) => r.path).sort()).toEqual([
			VISIT_IN_85,
			"Notes/visit.md",
		]);
	});

	it("explain gives each bound class's file", async () => {
		const api = apiOver(true);
		expect((await api.explain(VISIT_IN_85))?.classPaths).toEqual([SCOPED_VISIT]);
		expect((await api.explain("Notes/visit.md"))?.classPaths).toEqual(["Classes/Event/Visit.md"]);
	});

	it("validate --fileclass reads the name from its scope", async () => {
		const api = apiOver(true);
		// Every field is Input and empty: valid. The point is which notes are asked, and that a
		// scope-only name with its scope is not an unknown class.
		await expect(api.validate({ fileClass: "Case", scope: "80-89 D" })).resolves.toEqual([]);
	});

	it("a scope that names nothing is refused: thrown by a read, returned by a write", async () => {
		const api = apiOver(true);
		await expect(api.getSchema("Case", "No/such/place")).rejects.toThrow(/no scope, note or folder/);
		await expect(api.listNotes("Case", { scope: "No/such/place" })).rejects.toThrow(/no scope/);
		const result = await api.setValueWhere("Case", "docket", "1", undefined, "No/such/place");
		expect(result.ok).toBe(false);
		expect(result.changed).toBe(0);
		expect(result.errors[0].message).toMatch(/no scope, note or folder/);
	});

	it("openSchema opens the class the scope means", async () => {
		const api = apiOver(true);
		expect((await api.openSchema("Case")).ok).toBe(false);
		expect((await api.openSchema("Case", "80-89 D")).ok).toBe(true);
		expect(vi.mocked(openFileClassSchema)).toHaveBeenLastCalledWith(expect.anything(), "Case", undefined, "80-89 D");
	});
});
