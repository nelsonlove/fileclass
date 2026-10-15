/*
 * A small in-memory vault for the scope tests: files with frontmatter, the folders they imply,
 * and link resolution by path or by basename (the two forms `getFirstLinkpathDest` accepts).
 * Shared by scopeChain.test.ts (as a ScopeHost) and scopedIndex.test.ts (behind a fake App).
 */
import type { ScopeHost } from "../../src/schema/scopeChain";

export type Files = Record<string, Record<string, unknown>>;

export class FakeVault {
	readonly files: Files;
	readonly folders = new Set<string>([""]);

	constructor(files: Files, extraFolders: string[] = []) {
		this.files = files;
		for (const path of [...Object.keys(files), ...extraFolders.map((f) => `${f}/x`)]) {
			const parts = path.split("/");
			for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
		}
	}

	childFolders(path: string): string[] {
		const prefix = path ? `${path}/` : "";
		return [...this.folders]
			.filter((f) => f && f.startsWith(prefix) && !f.slice(prefix.length).includes("/"))
			.map((f) => f.slice(prefix.length));
	}

	resolveLink(linkpath: string): string | undefined {
		if (this.files[`${linkpath}.md`]) return `${linkpath}.md`;
		if (this.files[linkpath]) return linkpath;
		const base = linkpath.split("/").pop();
		return Object.keys(this.files).find((p) => p.split("/").pop() === `${base}.md`);
	}

	/** The vault as a ScopeHost, with the scope classes given by name. */
	host(scopeClasses: string[] = ["Meta/Scope", "Meta/Scope/Area", "Meta/Scope/Category", "Meta/Scope/Root"]): ScopeHost {
		return {
			frontmatterOf: (path) => this.files[path],
			isFile: (path) => path in this.files,
			isFolder: (path) => this.folders.has(path),
			childFolders: (path) => this.childFolders(path),
			resolveLink: (linkpath) => this.resolveLink(linkpath),
			isScopeClass: (name) => scopeClasses.includes(name),
		};
	}
}
