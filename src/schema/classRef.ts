/*
 * How a class is named where only a string travels — a log line, an audit finding (§10.3). A root
 * class is its name, as it always was. A scoped class is `name @ path`, because a name alone may
 * mean several classes and the log must say, and reopen, the one it is about.
 */

const SEP = " @ ";

/** `Score` for a root class, `Score @ 70-79 H/…/Score.md` for a scoped one. */
export function classRef(name: string, path: string, scope: string): string {
	return scope ? `${name}${SEP}${path}` : name;
}

/** The name and, for a scoped class, its file back out of a `classRef`. */
export function parseClassRef(ref: string): { name: string; path?: string } {
	// The first separator: a class name is a path below a classes folder and rarely holds one; a
	// vault path holds one more often.
	const i = ref.indexOf(SEP);
	if (i < 0 || !ref.slice(i + SEP.length).endsWith(".md")) return { name: ref };
	return { name: ref.slice(0, i), path: ref.slice(i + SEP.length) };
}

/** What the index must answer for the log's wrench to choose. */
export interface WrenchIndex {
	isFileClassNote(path: string): boolean;
	fileClassNameOfNote(path: string): string | undefined;
	resolveClass(name: string, ctx?: string): string | undefined;
	getFileClassFile(name: string, ctx?: string): unknown;
}

/**
 * Where a log line's wrench goes: the schema editor for a class the name reaches; the class file
 * itself for a class its scope gives twice, which binds nothing and so no lookup reaches (§10.3);
 * nothing for a class that is gone. The file is opened, not the editor, so no shared accessor has to
 * make an exception for a class that does not bind.
 */
export function wrenchTarget(
	index: WrenchIndex,
	ref: string
): { open: "schema"; name: string; path?: string } | { open: "file"; path: string } | { open: "gone" } {
	const { name, path } = parseClassRef(ref);
	// A scoped line whose class file is gone says so: read from a missing path, the name would fall
	// back to the root's class of the same name.
	if (path !== undefined && !index.isFileClassNote(path)) return { open: "gone" };
	if (index.getFileClassFile(name, path)) return { open: "schema", name, path };
	if (path !== undefined && index.resolveClass(name, path) === undefined && index.fileClassNameOfNote(path) === name) {
		return { open: "file", path };
	}
	return { open: "gone" };
}
