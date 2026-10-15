/*
 * The few runtime names of `obsidian` a unit test may reach. The package ships types only, so
 * without this alias (vitest.config.ts) a test that imports a module importing `obsidian` at
 * runtime cannot load at all. Keep it small: a test that needs more than this is an e2e test.
 */
export class TAbstractFile {
	constructor(public path: string) {}
	get name(): string {
		return this.path.split("/").pop() ?? "";
	}
}

export class TFile extends TAbstractFile {
	extension = "md";
	parent: { path: string } | null = null;
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

export class Events {
	trigger(): void {}
}

/** Frontmatter tags only, `#`-prefixed, as Obsidian's helper returns them. */
export function getAllTags(cache: { frontmatter?: { tags?: unknown } }): string[] {
	const tags = cache.frontmatter?.tags;
	return Array.isArray(tags) ? tags.map((t) => `#${String(t)}`) : [];
}

/** A notice says something to the reader; a unit test has no reader. */
export class Notice {
	constructor(_message?: string, _timeout?: number) {}
}
