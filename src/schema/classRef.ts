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
	const i = ref.lastIndexOf(SEP);
	if (i < 0 || !ref.slice(i + SEP.length).endsWith(".md")) return { name: ref };
	return { name: ref.slice(0, i), path: ref.slice(i + SEP.length) };
}
