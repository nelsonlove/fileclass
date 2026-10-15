/*
 * "Create a fileClass" command: prompt a name, capitalize it, create the class note, and open its
 * schema editor.
 *
 * With scoped classes off, the note is `<classFilesPath><Name>.md`, as always. On (§10.3), it first
 * asks which scope the class belongs to — the active note's scope offered first — and writes the
 * class into that scope's classes folder, making the folder when the pattern names one that does not
 * exist yet. A scoped class note carries `<alias>: Meta/Fileclass`, which is what makes it a class
 * there. Right-clicking a classes folder skips the question: the folder is the answer.
 */
import { Notice, TFile } from "obsidian";

import type FileclassPlugin from "../../main";
import { ChoiceSuggestModal, PromptModal } from "../fields/input/valueModals";
import { capitalize } from "../schema/field";
import { normaliseFolder, parentFolder, SCOPED_CLASS_TYPE } from "../schema/scopeChain";
import { FileClassSchemaModal } from "../ui/fileClassSchemaModal";

export interface CreateFileClassOptions {
	/** Create in this classes folder, without asking for a scope (the folder's context menu). */
	folder?: string;
}

/** One answer to "which scope?": the root, or a scope note, with the folder its class would go in. */
interface ScopeChoice {
	scope: string;
	folder: string;
	label: string;
}

export function createFileClass(plugin: FileclassPlugin, opts: CreateFileClassOptions = {}): void {
	const root = plugin.settings.classFilesPath;
	if (opts.folder !== undefined) {
		const folder = normaliseFolder(opts.folder);
		promptName(plugin, folder, folder !== normaliseFolder(root));
		return;
	}
	if (!plugin.settings.enableScopedClasses) {
		if (!root) {
			new Notice("Fileclass: set the class files folder in settings first.");
			return;
		}
		promptName(plugin, normaliseFolder(root), false);
		return;
	}
	const choices = scopeChoices(plugin);
	if (!choices.length) {
		new Notice("Fileclass: no scope has a classes folder, and the class files folder is not set.");
		return;
	}
	new ChoiceSuggestModal<ScopeChoice>(
		plugin.app,
		choices,
		(c) => c.label,
		(c) => promptName(plugin, c.folder, c.scope !== ""),
		"Create the class in which scope?"
	).open();
}

/**
 * Every scope a class can be created in, the active note's first, then the root, then the rest by
 * folder. A scope whose classes folder cannot be named (no `.03` slot) is left out.
 */
export function scopeChoices(plugin: FileclassPlugin): ScopeChoice[] {
	const index = plugin.index;
	const choices: ScopeChoice[] = [];
	const add = (scope: string): void => {
		if (choices.some((c) => c.scope === scope)) return;
		const folder = index.classesFolderForNewClass(scope);
		if (folder === undefined) return;
		const where = scope ? parentFolder(scope) || scope : "Root";
		choices.push({ scope, folder, label: `${where} — ${folder || "/"}` });
	};
	const active = plugin.app.workspace.getActiveFile();
	if (active) add(index.scopeOf(active));
	add("");
	for (const scope of [...index.scopeNotes].sort((a, b) => a.localeCompare(b))) add(scope);
	return choices;
}

function promptName(plugin: FileclassPlugin, folder: string, scoped: boolean): void {
	new PromptModal(plugin.app, {
		title: "Create a fileClass",
		placeholder: "fileClass name",
		validate: (v) => (v.trim() ? { ok: true } : { ok: false, message: "A name is required." }),
		onSubmit: (raw) => void createNote(plugin, folder, raw, scoped),
	}).open();
}

/** The new class note's text: a scoped class says what it is, or it is not read as one. */
export function newClassContent(scoped: boolean, typeKey: string): string {
	return scoped ? `---\n${typeKey}: ${SCOPED_CLASS_TYPE}\nfields: []\n---\n` : "---\nfields: []\n---\n";
}

async function createNote(plugin: FileclassPlugin, folder: string, raw: string, scoped: boolean): Promise<void> {
	const name = capitalize(raw.trim());
	const path = folder ? `${folder}/${name}.md` : `${name}.md`;

	const existing = plugin.app.vault.getFileByPath(path);
	if (existing instanceof TFile) {
		new Notice(`Fileclass: "${name}" already exists.`);
		new FileClassSchemaModal(plugin, name, existing).open();
		return;
	}

	let file: TFile;
	try {
		await ensureFolder(plugin, path);
		file = await plugin.app.vault.create(path, newClassContent(scoped, plugin.settings.fileClassAlias));
	} catch (err) {
		new Notice(`Fileclass: couldn't create "${name}" — ${(err as Error).message}`);
		return;
	}
	// Opened on the file itself: the index learns of the class on its next rebuild, and a scoped
	// name cannot be looked up before then.
	new FileClassSchemaModal(plugin, name, file).open();
}

async function ensureFolder(plugin: FileclassPlugin, path: string): Promise<void> {
	const parent = path.split("/").slice(0, -1).join("/");
	if (!parent || plugin.app.vault.getFolderByPath(parent)) return;
	try {
		await plugin.app.vault.createFolder(parent);
	} catch {
		/* already exists (race) */
	}
}
