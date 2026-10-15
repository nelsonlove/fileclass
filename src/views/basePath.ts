/*
 * Where a class's generated base goes (ARCHITECTURE.md §10.3, §11). Pure, so the rule is pinned by
 * tests rather than by trial in the app.
 *
 * A root class keeps today's default: its declared `baseFile`, else `<basesFolder><name>.base`. A
 * scoped class has no default in the root's bases folder: a scope's generated bases belong to the
 * scope, so the modal offers `<scope>/<NN>.07 …/bases/generated/<name>.base` when that folder
 * exists, and nothing otherwise. A base is never written beside a class, in a classes folder:
 * there it would sit among the definitions it describes.
 */
import { areaDigit, normaliseFolder, parentFolder } from "../schema/scopeChain";

/** The `.07` slot of a scope: a child folder named like `75.07 Views`. */
const VIEWS_SLOT = /^\d\d\.07 /;

/** The folder below the `.07` slot that holds generated bases. */
const GENERATED = "bases/generated";

export interface BaseFolderHost {
	/** Names of the direct child folders of `path`. */
	childFolders(path: string): string[];
	/** True when a folder exists at `path`. */
	isFolder(path: string): boolean;
}

/**
 * The generated-bases folder of a scope folder, if it exists: its `.07` slot's `bases/generated`.
 * An area has no slot of its own, so its management category's is used, as for its classes.
 */
export function generatedBasesFolder(scopeFolder: string, host: BaseFolderHost): string | undefined {
	let folder = normaliseFolder(scopeFolder);
	if (!folder) return undefined;
	const digit = areaDigit(folder.slice(folder.lastIndexOf("/") + 1));
	if (digit !== undefined) {
		const management = [...host.childFolders(folder)].sort().find((n) => n.startsWith(`${digit}0 `));
		if (!management) return undefined;
		folder = `${folder}/${management}`;
	}
	for (const name of [...host.childFolders(folder)].sort()) {
		if (!VIEWS_SLOT.test(name)) continue;
		const generated = `${folder}/${name}/${GENERATED}`;
		if (host.isFolder(generated)) return generated;
	}
	return undefined;
}

export interface DefaultBasePathInput {
	/** The class's name. */
	name: string;
	/** Its declared `baseFile`, if any. */
	declared?: string;
	/** The root's bases folder setting (with its trailing slash). */
	basesFolder: string;
	/** The folder of the class's scope; undefined for a root class. */
	scopeFolder?: string;
}

/** The path the base modal starts from; "" when a scoped class has nowhere to put one. */
export function defaultBasePath(input: DefaultBasePathInput, host: BaseFolderHost): string {
	const declared = input.declared?.trim();
	if (declared) return declared;
	if (input.scopeFolder === undefined) return `${input.basesFolder}${input.name}.base`;
	const generated = generatedBasesFolder(input.scopeFolder, host);
	return generated ? `${generated}/${input.name}.base` : "";
}

/**
 * True when a base path sits in one of the classes folders, at any depth. A blank entry (no class
 * files folder set, or the vault root) names no folder to keep clear, so it refuses nothing.
 */
export function isBesideClasses(basePath: string, classesFolders: string[]): boolean {
	const folder = parentFolder(normaliseFolder(basePath));
	return classesFolders
		.map(normaliseFolder)
		.filter((c) => c !== "")
		.some((c) => folder === c || folder.startsWith(`${c}/`));
}
