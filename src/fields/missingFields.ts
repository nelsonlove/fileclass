/*
 * Which root fields a note is missing (ARCHITECTURE.md §12). Kept apart from
 * the insert command — which needs the Obsidian runtime — so the rule can be
 * tested, and so the Properties action button can ask "how many?" without
 * touching the note. One definition of "missing" for both, or the button lies.
 *
 * The rule itself is pure: the only runtime it reaches is the settings behind
 * `settingsScope()`, and that answers the default scope when there is none.
 */
import { getPlugin, hasPlugin } from "../globals";
import { Field, isRootField } from "../schema/field";
import { isRequired } from "./validate";

/** Which of a class's fields count as missing at all. */
export interface MissingFieldsScope {
	/**
	 * Only the fields the class marks `required` are missing; an optional field a note does not
	 * carry is not a gap. Default `false` — every root field counts, which is what the command
	 * has always done.
	 */
	requiredOnly?: boolean;
}

/**
 * The scope the settings ask for, read once, here.
 *
 * It is the default of `missingRootFields` rather than an argument at each call site for the
 * reason `insertMissingFields` gives about its own `reorder`: "what is missing" is asked in six
 * places — a command, two menus, two modals and the API — and two of them only *count*, to label
 * a button. A preference honoured on the write but not on the count is a button that lies.
 *
 * Falls back to the default scope when the plugin is not loaded, so the pure rule stays callable
 * (and testable) with no runtime at all.
 */
export function settingsScope(): MissingFieldsScope {
	return { requiredOnly: hasPlugin() && getPlugin().settings.insertRequiredFieldsOnly };
}

/**
 * The root fields absent from a note, de-duplicated by name (a note may bind
 * several fileClasses sharing a field). `present` answers "does the note
 * already carry this field?" — the app-facing caller passes hasFieldKey.
 * `scope` narrows what counts as missing; left out, it follows the setting.
 */
export function missingRootFields(
	fields: Field[],
	present: (field: Field) => boolean,
	scope: MissingFieldsScope = settingsScope()
): Field[] {
	const out: Field[] = [];
	const seen = new Set<string>();
	for (const field of fields) {
		if (!isRootField(field) || present(field) || seen.has(field.name)) continue;
		if (scope.requiredOnly && !isRequired(field)) continue;
		seen.add(field.name);
		out.push(field);
	}
	return out;
}

