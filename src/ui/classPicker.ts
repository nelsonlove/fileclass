/*
 * One picker for "which class?", scoped classes included (§10.3). A root class shows its name; a
 * scoped one shows its name and its scope's folder, so two classes of one name are told apart.
 */
import { Notice } from "obsidian";

import type FileclassPlugin from "../../main";
import { ChoiceSuggestModal } from "../fields/input/valueModals";
import type { ClassEntry } from "../schema/fileclassIndex";
import { parentFolder } from "../schema/scopeChain";

/** `Visit` for a root class, `Visit — 80-89 Divorce` for a scoped one. */
export function classLabel(entry: ClassEntry): string {
	return entry.scope ? `${entry.name} — ${parentFolder(entry.scope) || entry.scope}` : entry.name;
}

/** Root classes first, then by name, then by scope. */
export function sortClasses(entries: ClassEntry[]): ClassEntry[] {
	return [...entries].sort(
		(a, b) =>
			Number(a.scope !== "") - Number(b.scope !== "") ||
			a.name.localeCompare(b.name) ||
			a.scope.localeCompare(b.scope)
	);
}

/** Opens the picker over every class; a Notice when there is none. */
export function pickClass(
	plugin: FileclassPlugin,
	placeholder: string,
	onPick: (entry: ClassEntry) => void
): void {
	const entries = sortClasses(plugin.index.allClasses());
	if (!entries.length) {
		new Notice("Fileclass: no fileClasses defined.");
		return;
	}
	new ChoiceSuggestModal<ClassEntry>(plugin.app, entries, classLabel, onPick, placeholder).open();
}
