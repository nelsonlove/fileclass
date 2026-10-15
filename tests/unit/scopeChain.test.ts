import { describe, expect, it } from "vitest";

import {
	areaDigit,
	chainOf,
	classesFoldersOf,
	classesFolderToCreate,
	isFolderNote,
	isScopeNote,
	linkTarget,
	matchesPatternPath,
	MAX_CHAIN_DEPTH,
	parsePattern,
	scopeOfFolder,
	scopeOfNote,
	ScopeSettings,
} from "../../src/schema/scopeChain";
import { FakeVault } from "./fakeVault";

const settings: ScopeSettings = {
	typeKey: "type",
	parentKey: "up",
	classesKey: "classes",
	pattern: "\\d\\d\\.03 .*/classes",
};
const { segments } = parsePattern(settings.pattern);

/** Root note at the top, one area, its management category and one other category. */
function vault(): FakeVault {
	return new FakeVault(
		{
			"My vault.md": { type: "Meta/Scope/Root" },
			"80-89 Divorce/80-89 Divorce.md": { type: "Meta/Scope/Area", up: "[[My vault]]" },
			"80-89 Divorce/80 Management/80 Management.md": { type: "Meta/Scope/Category", up: "[[80-89 Divorce]]" },
			"80-89 Divorce/80 Management/80.03 Shapes/80.03 Shapes.md": { type: "Meta/Slot/Shapes" },
			"80-89 Divorce/80 Management/80.03 Shapes/classes/classes.md": { type: "Meta/Collection" },
			"80-89 Divorce/85 Evidence/85 Evidence.md": { type: "Meta/Scope/Category", up: "[[80-89 Divorce/80-89 Divorce|Divorce]]" },
			"80-89 Divorce/85 Evidence/85.03 Shapes/classes/Event/Visit.md": { type: "Meta/Fileclass" },
			"80-89 Divorce/85 Evidence/85.11 Visits/note.md": { type: "Event/Visit" },
			"80-89 Divorce/85 Evidence/85.11 Visits/85.11 Visits.md": { type: "Meta/Slot" },
			"80-89 Divorce/85 Evidence/85.11 Visits/linked.md": { scope: "[[80 Management]]" },
			"80-89 Divorce/85 Evidence/85.11 Visits/text.md": { scope: "everything about visits" },
			"Loose/note.md": {},
		},
		["80-89 Divorce/80 Management/80.03 Shapes/classes"]
	);
}

describe("folder notes and scope notes", () => {
	it("knows a folder note by its name", () => {
		expect(isFolderNote("A/B/B.md")).toBe(true);
		expect(isFolderNote("A/B/C.md")).toBe(false);
		expect(isFolderNote("Top.md")).toBe(false);
	});

	it("a scope note is a folder note with a scope class", () => {
		const v = vault();
		const h = v.host();
		expect(isScopeNote("80-89 Divorce/80-89 Divorce.md", h, settings)).toBe(true);
		// A slot note is a folder note, but not of a scope class.
		expect(isScopeNote("80-89 Divorce/85 Evidence/85.11 Visits/85.11 Visits.md", h, settings)).toBe(false);
		// A scope class on a note that is not its folder's note does not make a scope.
		v.files["80-89 Divorce/85 Evidence/stray.md"] = { type: "Meta/Scope/Category" };
		expect(isScopeNote("80-89 Divorce/85 Evidence/stray.md", h, settings)).toBe(false);
		// The root note sits at the top of the vault, where no folder is its own.
		expect(isScopeNote("My vault.md", h, settings)).toBe(true);
	});

	it("reads the type through the configured key, a list included", () => {
		const v = new FakeVault({ "A/A.md": { fileClass: ["Other", "Meta/Scope"] } });
		expect(isScopeNote("A/A.md", v.host(), { ...settings, typeKey: "fileClass" })).toBe(true);
		expect(isScopeNote("A/A.md", v.host(), settings)).toBe(false);
	});
});

describe("scopeOfFolder / scopeOfNote", () => {
	it("finds the nearest folder holding a scope note, stepping over slots", () => {
		const h = vault().host();
		expect(scopeOfFolder("80-89 Divorce/85 Evidence/85.11 Visits", h, settings)).toBe(
			"80-89 Divorce/85 Evidence/85 Evidence.md"
		);
		expect(scopeOfFolder("80-89 Divorce", h, settings)).toBe("80-89 Divorce/80-89 Divorce.md");
	});

	it("gives undefined (the root) outside every scope", () => {
		expect(scopeOfFolder("Loose", vault().host(), settings)).toBeUndefined();
	});

	it("caches every folder it walked through", () => {
		const cache = new Map<string, string | undefined>();
		scopeOfFolder("80-89 Divorce/85 Evidence/85.11 Visits", vault().host(), settings, cache);
		expect(cache.get("80-89 Divorce/85 Evidence/85.11 Visits")).toBe("80-89 Divorce/85 Evidence/85 Evidence.md");
		expect(cache.get("80-89 Divorce/85 Evidence")).toBe("80-89 Divorce/85 Evidence/85 Evidence.md");
	});

	it("a scope: link to a scope note wins over the folder; free text does not", () => {
		const h = vault().host();
		expect(scopeOfNote("80-89 Divorce/85 Evidence/85.11 Visits/linked.md", h, settings)).toBe(
			"80-89 Divorce/80 Management/80 Management.md"
		);
		expect(scopeOfNote("80-89 Divorce/85 Evidence/85.11 Visits/text.md", h, settings)).toBe(
			"80-89 Divorce/85 Evidence/85 Evidence.md"
		);
	});
});

describe("chainOf", () => {
	it("walks up to the root, by basename or by path, an alias ignored", () => {
		const { chain, errors } = chainOf("80-89 Divorce/85 Evidence/85 Evidence.md", vault().host(), settings);
		expect(chain).toEqual([
			"80-89 Divorce/85 Evidence/85 Evidence.md",
			"80-89 Divorce/80-89 Divorce.md",
			"My vault.md",
		]);
		expect(errors).toEqual([]);
	});

	it("follows the configured key", () => {
		const v = vault();
		v.files["80-89 Divorce/80-89 Divorce.md"] = { type: "Meta/Scope/Area", parent: "[[My vault]]" };
		const { chain } = chainOf("80-89 Divorce/80-89 Divorce.md", v.host(), { ...settings, parentKey: "parent" });
		expect(chain).toEqual(["80-89 Divorce/80-89 Divorce.md", "My vault.md"]);
	});

	it("stops on a cycle and says so", () => {
		const v = new FakeVault({
			"A/A.md": { type: "Meta/Scope", up: "[[B]]" },
			"B/B.md": { type: "Meta/Scope", up: "[[A]]" },
		});
		const { chain, errors } = chainOf("A/A.md", v.host(), settings);
		expect(chain).toEqual(["A/A.md", "B/B.md"]);
		expect(errors[0]).toMatch(/cycle/);
	});

	it("stops on a link that resolves to nothing", () => {
		const v = new FakeVault({ "A/A.md": { type: "Meta/Scope", up: "[[Nowhere]]" } });
		const { chain, errors } = chainOf("A/A.md", v.host(), settings);
		expect(chain).toEqual(["A/A.md"]);
		expect(errors[0]).toMatch(/does not resolve/);
	});

	it("stops on a target that is not a scope note", () => {
		const v = new FakeVault({
			"A/A.md": { type: "Meta/Scope", up: "[[Plain]]" },
			"Plain.md": { type: "Note" },
		});
		const { chain, errors } = chainOf("A/A.md", v.host(), settings);
		expect(chain).toEqual(["A/A.md"]);
		expect(errors[0]).toMatch(/not a scope note/);
	});

	it("ends quietly at a scope with no up", () => {
		const v = new FakeVault({ "A/A.md": { type: "Meta/Scope" } });
		expect(chainOf("A/A.md", v.host(), settings)).toEqual({ chain: ["A/A.md"], errors: [] });
	});

	it("gives up past the depth cap", () => {
		const files: Record<string, Record<string, unknown>> = {};
		for (let i = 0; i < MAX_CHAIN_DEPTH + 5; i++) {
			files[`S${i}/S${i}.md`] = { type: "Meta/Scope", up: `[[S${i + 1}]]` };
		}
		files[`S${MAX_CHAIN_DEPTH + 5}/S${MAX_CHAIN_DEPTH + 5}.md`] = { type: "Meta/Scope" };
		const { chain, errors } = chainOf("S0/S0.md", new FakeVault(files).host(), settings);
		expect(chain).toHaveLength(MAX_CHAIN_DEPTH);
		expect(errors[0]).toMatch(/deeper than 16/);
	});
});

describe("classesFoldersOf", () => {
	it("finds the pattern below a category", () => {
		const h = vault().host();
		expect(classesFoldersOf("80-89 Divorce/85 Evidence/85 Evidence.md", h, settings, segments)).toEqual([
			"80-89 Divorce/85 Evidence/85.03 Shapes/classes",
		]);
	});

	it("gives an area its management category's folder", () => {
		const h = vault().host();
		expect(areaDigit("80-89 Divorce")).toBe("8");
		expect(areaDigit("80 Management")).toBeUndefined();
		expect(classesFoldersOf("80-89 Divorce/80-89 Divorce.md", h, settings, segments)).toEqual([
			"80-89 Divorce/80 Management/80.03 Shapes/classes",
		]);
	});

	it("lets a scope note name its folder(s) with the classes key", () => {
		const v = vault();
		v.files["80-89 Divorce/85 Evidence/85 Evidence.md"].classes = ["[[Loose]]", "Missing/folder"];
		expect(classesFoldersOf("80-89 Divorce/85 Evidence/85 Evidence.md", v.host(), settings, segments)).toEqual([
			"Loose",
		]);
	});

	it("gives the root note nothing: its folder is the setting", () => {
		expect(classesFoldersOf("My vault.md", vault().host(), settings, segments)).toEqual([]);
	});

	it("gives nothing where the pattern finds nothing", () => {
		const v = new FakeVault({ "A/A.md": { type: "Meta/Scope" } });
		expect(classesFoldersOf("A/A.md", v.host(), settings, segments)).toEqual([]);
	});
});

describe("patterns and links", () => {
	it("refuses an invalid or empty pattern", () => {
		expect(parsePattern("(/classes").error).toMatch(/invalid/);
		expect(parsePattern(" / ").error).toMatch(/empty/);
	});

	it("matches a folder path that holds the pattern", () => {
		expect(matchesPatternPath("80-89 X/80 M/80.03 Shapes/classes/Event", segments)).toBe(true);
		expect(matchesPatternPath("80-89 X/80 M/80.03 Shapes", segments)).toBe(false);
	});

	it("reads a link target from a wikilink or a path", () => {
		expect(linkTarget("[[A/B|alias]]")).toBe("A/B");
		expect(linkTarget("[[A#h]]")).toBe("A");
		expect(linkTarget(["[[A]]"])).toBe("A");
		expect(linkTarget("A/B")).toBe("A/B");
		expect(linkTarget(3)).toBeUndefined();
	});
});

describe("classesFolderToCreate", () => {
	it("an existing classes folder first", () => {
		const v = vault();
		expect(classesFolderToCreate("80-89 Divorce/80 Management/80 Management.md", v.host(), settings, segments)).toBe(
			"80-89 Divorce/80 Management/80.03 Shapes/classes"
		);
		expect(classesFolderToCreate("80-89 Divorce/80-89 Divorce.md", v.host(), settings, segments)).toBe(
			"80-89 Divorce/80 Management/80.03 Shapes/classes"
		);
	});

	it("else the folder the pattern names below an existing slot", () => {
		const v = new FakeVault({
			"30 New/30 New.md": { type: "Meta/Scope/Category" },
			"30 New/30.03 Shapes/30.03 Shapes.md": { type: "Meta/Slot/Shapes" },
		});
		expect(classesFolderToCreate("30 New/30 New.md", v.host(), settings, segments)).toBe("30 New/30.03 Shapes/classes");
	});

	it("nothing without a slot, with a classes key naming no folder, or with an expression last", () => {
		const v = new FakeVault({
			"31 Bare/31 Bare.md": { type: "Meta/Scope/Category" },
			"32 Keyed/32 Keyed.md": { type: "Meta/Scope/Category", classes: "32 Keyed/missing" },
			"32 Keyed/32.03 Shapes/32.03 Shapes.md": {},
		});
		expect(classesFolderToCreate("31 Bare/31 Bare.md", v.host(), settings, segments)).toBeUndefined();
		expect(classesFolderToCreate("32 Keyed/32 Keyed.md", v.host(), settings, segments)).toBeUndefined();
		const loose = parsePattern("\\d\\d\\.03 .*/class.*").segments;
		const w = new FakeVault({ "33 X/33 X.md": {}, "33 X/33.03 Shapes/s.md": {} });
		expect(classesFolderToCreate("33 X/33 X.md", w.host(), settings, loose)).toBeUndefined();
	});
});
