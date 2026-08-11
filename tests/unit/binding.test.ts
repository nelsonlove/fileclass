import { describe, it, expect } from "vitest";

import {
	resolveExtendsName,
	resolveGlobalFileClassName,
	resolveInnerFileClassNames,
} from "../../src/schema/resolver";

const nameByPath = new Map([
	["cls/Area.fileclass.md", "Area.fileclass"],
	["cls/Task.fileclass.md", "Task.fileclass"],
]);
const resolve = (link: string): string | null => {
	const hit = [...nameByPath.keys()].find((p) => p.endsWith(`/${link}.md`));
	return hit ?? null;
};

describe("resolveInnerFileClassNames", () => {
	it("resolves a scalar alias link (key === alias)", () => {
		const links = [{ key: "fileClass", link: "Area.fileclass" }];
		expect(resolveInnerFileClassNames(links, "fileClass", resolve, nameByPath)).toEqual([
			"Area.fileclass",
		]);
	});
	it("resolves array items (key === alias.<n>) preserving order", () => {
		const links = [
			{ key: "fileClass.0", link: "Area.fileclass" },
			{ key: "fileClass.1", link: "Task.fileclass" },
		];
		expect(resolveInnerFileClassNames(links, "fileClass", resolve, nameByPath)).toEqual([
			"Area.fileclass",
			"Task.fileclass",
		]);
	});
	it("ignores links for other frontmatter keys", () => {
		const links = [{ key: "blueprint", link: "Area.fileclass" }];
		expect(resolveInnerFileClassNames(links, "fileClass", resolve, nameByPath)).toEqual([]);
	});
	it("drops unresolved links and non-fileclass targets, de-dupes", () => {
		const links = [
			{ key: "fileClass.0", link: "Missing.fileclass" },
			{ key: "fileClass.1", link: "Area.fileclass" },
			{ key: "fileClass.2", link: "Area.fileclass" },
		];
		expect(resolveInnerFileClassNames(links, "fileClass", resolve, nameByPath)).toEqual([
			"Area.fileclass",
		]);
	});
});

describe("resolveExtendsName", () => {
	const has = (n: string): boolean => n === "Note.fileclass" || n === "Global.fileclass";
	const resolveLink = (link: string): string | undefined =>
		link === "Note.fileclass" ? "Note.fileclass" : undefined;

	it("resolves a wikilink extends", () => {
		expect(resolveExtendsName('[[Note.fileclass]]', resolveLink, has)).toBe("Note.fileclass");
	});
	it("strips a |alias and #subpath from the wikilink before resolving", () => {
		expect(resolveExtendsName('[[Note.fileclass|Note]]', resolveLink, has)).toBe("Note.fileclass");
		expect(resolveExtendsName('[[Note.fileclass#Heading]]', resolveLink, has)).toBe(
			"Note.fileclass"
		);
	});
	it("resolves a bare name that already matches a registry key", () => {
		expect(resolveExtendsName("Note.fileclass", resolveLink, has)).toBe("Note.fileclass");
	});
	it("resolves a bare display name by appending the .fileclass suffix", () => {
		expect(resolveExtendsName("Note", resolveLink, has)).toBe("Note.fileclass");
	});
	it("returns undefined for empty or unresolvable values", () => {
		expect(resolveExtendsName(undefined, resolveLink, has)).toBeUndefined();
		expect(resolveExtendsName("[[Missing.fileclass]]", resolveLink, has)).toBeUndefined();
		expect(resolveExtendsName("Nope", resolveLink, has)).toBeUndefined();
	});
});

describe("resolveGlobalFileClassName", () => {
	const has = (n: string): boolean => n === "Default.fileclass";
	// Faithful to getFirstLinkpathDest: a link may carry a folder path, and it
	// resolves to the same file. A fake that only matched the bare name would let a
	// path-carrying wikilink pass for the wrong reason.
	const resolveLink = (link: string): string | undefined =>
		link === "Default.fileclass" || link === "Classes/Default.fileclass"
			? "Default.fileclass"
			: undefined;

	// The regression this function exists for. Every other class reference in this
	// fork is a wikilink, so that is what gets typed into the setting too — and the
	// earlier resolver matched bare names, suffixed names and paths but not links,
	// so the global binding silently never fired.
	it("resolves a wikilink, the form every other class reference uses", () => {
		expect(resolveGlobalFileClassName("[[Default.fileclass]]", resolveLink, has)).toBe(
			"Default.fileclass"
		);
	});

	it("strips a |alias and #subpath, like extends does", () => {
		expect(resolveGlobalFileClassName("[[Default.fileclass|Default]]", resolveLink, has)).toBe(
			"Default.fileclass"
		);
		expect(resolveGlobalFileClassName("[[Default.fileclass#Fields]]", resolveLink, has)).toBe(
			"Default.fileclass"
		);
	});

	it("still resolves a bare name and a display name", () => {
		expect(resolveGlobalFileClassName("Default.fileclass", resolveLink, has)).toBe(
			"Default.fileclass"
		);
		expect(resolveGlobalFileClassName("Default", resolveLink, has)).toBe("Default.fileclass");
	});

	it("still resolves a path, which a legacy classFilesPath value could carry", () => {
		expect(resolveGlobalFileClassName("Classes/Default.fileclass", resolveLink, has)).toBe(
			"Default.fileclass"
		);
		expect(resolveGlobalFileClassName("Classes/Default.md", resolveLink, has)).toBe(
			"Default.fileclass"
		);
	});

	it("resolves a wikilink that carries a folder path", () => {
		expect(resolveGlobalFileClassName("[[Classes/Default.fileclass]]", resolveLink, has)).toBe(
			"Default.fileclass"
		);
	});

	it("tolerates surrounding whitespace", () => {
		expect(resolveGlobalFileClassName("  [[Default.fileclass]]  ", resolveLink, has)).toBe(
			"Default.fileclass"
		);
	});

	it("returns undefined for empty and unresolvable values", () => {
		expect(resolveGlobalFileClassName(undefined, resolveLink, has)).toBeUndefined();
		expect(resolveGlobalFileClassName("", resolveLink, has)).toBeUndefined();
		expect(resolveGlobalFileClassName("   ", resolveLink, has)).toBeUndefined();
		expect(resolveGlobalFileClassName("[[Missing.fileclass]]", resolveLink, has)).toBeUndefined();
		expect(resolveGlobalFileClassName("Nope", resolveLink, has)).toBeUndefined();
	});
});
