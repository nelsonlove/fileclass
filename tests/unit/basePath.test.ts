/*
 * Where a class's generated base goes (§10.3, §11): a root class keeps today's default; a scoped
 * class is offered its scope's `.07 …/bases/generated/` or nothing; never a classes folder.
 */
import { describe, expect, it } from "vitest";

import { defaultBasePath, generatedBasesFolder, isBesideClasses } from "../../src/views/basePath";
import { FakeVault } from "./fakeVault";

const vault = new FakeVault(
	{
		"40 F/40 F.md": {},
		"40 F/40.07 Views/bases/generated/generated.md": {},
		"41 G/41 G.md": {},
		"41 G/41.07 Views/41.07 Views.md": {},
		"70-79 H/70-79 H.md": {},
		"70-79 H/70 M/70.07 Views/bases/generated/x.md": {},
	},
	[]
);
const host = { childFolders: (p: string) => vault.childFolders(p), isFolder: (p: string) => vault.folders.has(p) };

describe("defaultBasePath", () => {
	it("a root class: its declared base, else the bases folder", () => {
		expect(defaultBasePath({ name: "Book", basesFolder: "Bases/" }, host)).toBe("Bases/Book.base");
		expect(defaultBasePath({ name: "Book", basesFolder: "Bases/", declared: " X/Y.base " }, host)).toBe("X/Y.base");
	});

	it("a scoped class: its scope's generated folder, or no path at all", () => {
		expect(defaultBasePath({ name: "Ledger", basesFolder: "Bases/", scopeFolder: "40 F" }, host)).toBe(
			"40 F/40.07 Views/bases/generated/Ledger.base"
		);
		expect(defaultBasePath({ name: "Ledger", basesFolder: "Bases/", scopeFolder: "41 G" }, host)).toBe("");
		expect(defaultBasePath({ name: "Event/Session", basesFolder: "Bases/", scopeFolder: "70-79 H" }, host)).toBe(
			"70-79 H/70 M/70.07 Views/bases/generated/Event/Session.base"
		);
		// Declared wins for a scoped class too.
		expect(defaultBasePath({ name: "L", basesFolder: "Bases/", scopeFolder: "41 G", declared: "A.base" }, host)).toBe("A.base");
	});

	it("an area uses its management category's slot", () => {
		expect(generatedBasesFolder("70-79 H", host)).toBe("70-79 H/70 M/70.07 Views/bases/generated");
		expect(generatedBasesFolder("", host)).toBeUndefined();
	});
});

describe("isBesideClasses", () => {
	const classes = ["Classes/", "40 F/40.03 Shapes/classes"];
	it("refuses a path inside a classes folder, at any depth", () => {
		expect(isBesideClasses("40 F/40.03 Shapes/classes/Ledger.base", classes)).toBe(true);
		expect(isBesideClasses("40 F/40.03 Shapes/classes/Sub/Ledger.base", classes)).toBe(true);
		expect(isBesideClasses("Classes/Book.base", classes)).toBe(true);
	});
	it("lets a path elsewhere through, a look-alike prefix included", () => {
		expect(isBesideClasses("40 F/40.07 Views/bases/generated/Ledger.base", classes)).toBe(false);
		expect(isBesideClasses("40 F/40.03 Shapes/classes-old/Ledger.base", classes)).toBe(false);
		expect(isBesideClasses("Ledger.base", ["", ...classes])).toBe(false);
	});
});
