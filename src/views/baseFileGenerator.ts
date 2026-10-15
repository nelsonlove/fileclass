/*
 * "Create a base for a fileClass" (ARCHITECTURE.md §11): an interactive setup —
 * pick the base file path and the managed view name — that stores them on the
 * fileClass (`baseFile`/`baseView`) and applies the mirror via the sync path.
 * Non-destructive: an existing base only gets its managed view touched (§11).
 */
import { Modal, Notice, Setting, TFolder, normalizePath } from "obsidian";

import { modalTitle } from "../ui/modalTitle";

import type FileclassPlugin from "../../main";
import { writeOptions } from "../schema/fileClassIo";
import type { ClassContext } from "../schema/fileclassIndex";
import { parentFolder } from "../schema/scopeChain";
import { pickClass } from "../ui/classPicker";
import { BaseFolderHost, defaultBasePath, isBesideClasses } from "./basePath";
import { BaseFileSuggest } from "../ui/baseSuggest";
import { applyBaseSync, fileClassClaimingView, managedViewName } from "./baseSync";

class CreateBaseModal extends Modal {
	private path: string;
	private view: string;

	constructor(
		private readonly plugin: FileclassPlugin,
		private readonly name: string,
		/** Where the name is read from (§10.3); none means the root's class. */
		private readonly ctx?: ClassContext
	) {
		super(plugin.app);
		const scope = plugin.index.scopeOf(ctx);
		this.path = defaultBasePath(
			{
				name,
				declared: plugin.index.getFileClass(name, ctx)?.options.baseFile,
				basesFolder: plugin.settings.basesFolder,
				scopeFolder: scope ? parentFolder(scope) : undefined,
			},
			folderHost(plugin)
		);
		this.view = managedViewName(plugin, name, ctx);
	}

	onOpen(): void {
		const { contentEl } = this;
		modalTitle(contentEl, `Sync ${this.name} to a base`);

		new Setting(contentEl)
			.setName("Base file")
			.setDesc("New or existing .base to mirror this fileClass's fields into.")
			.addText((t) => {
				t.setValue(this.path).onChange((v) => (this.path = v));
				new BaseFileSuggest(this.app, t.inputEl);
			});
		new Setting(contentEl)
			.setName("View name")
			.setDesc("The managed view (other views in the base are left untouched).")
			.addText((t) => t.setValue(this.view).onChange((v) => (this.view = v)));

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Create / sync")
				.setCta()
				.onClick(() => void this.apply())
		);
	}

	private async apply(): Promise<void> {
		let path = this.path.trim();
		if (!path) {
			new Notice("Fileclass: a base file path is required.");
			return;
		}
		if (!path.endsWith(".base")) path += ".base";
		path = normalizePath(path);

		// A scoped class's base among the class definitions would sit where nobody looks for bases
		// (§10.3). Refused, and the reason named. A root class keeps today's freedom: its default is
		// the bases folder, and a vault may have set that to anything.
		const scoped = this.plugin.index.scopeOf(this.ctx) !== "";
		const classesFolders = [this.plugin.settings.classFilesPath, ...this.plugin.index.scopedClassesFolders()];
		if (scoped && isBesideClasses(path, classesFolders)) {
			new Notice("Fileclass: a base cannot go in a classes folder. Choose a folder for views.");
			return;
		}
		const view = this.view.trim() || this.name;

		// Two classes mirroring into one view would overwrite each other's columns on every
		// sync, quietly and forever. Refused before anything is written, and named: the answer
		// is a different view name, which is one word away in the field above.
		const taken = fileClassClaimingView(this.plugin, path, view, this.name, this.ctx);
		if (taken) {
			new Notice(
				`Fileclass: "${taken}" already mirrors into ${path} › ${view}. ` +
					"Give this one a view name of its own."
			);
			return;
		}

		const fcFile = this.plugin.index.getFileClassFile(this.name, this.ctx);
		if (fcFile) await writeOptions(this.app, fcFile, { baseFile: path, baseView: view });
		// Use explicit path/view — the metadata cache may not reflect the write yet.
		await applyBaseSync(this.plugin, this.name, path, view, this.ctx);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** The vault's folders, as the base-path rule sees them. */
function folderHost(plugin: FileclassPlugin): BaseFolderHost {
	const vault = plugin.app.vault;
	return {
		childFolders: (path) => {
			const folder = vault.getAbstractFileByPath(path);
			return folder instanceof TFolder
				? folder.children.filter((c) => c instanceof TFolder).map((c) => c.name)
				: [];
		},
		isFolder: (path) => vault.getAbstractFileByPath(path) instanceof TFolder,
	};
}

/**
 * Opens the create/sync setup for `name` (read from `ctx`), or a picker over every class, scoped
 * ones included, when omitted.
 */
export function pickAndCreateBase(plugin: FileclassPlugin, name?: string, ctx?: ClassContext): void {
	if (name) {
		new CreateBaseModal(plugin, name, ctx).open();
		return;
	}
	pickClass(plugin, "Select a fileClass to sync to a base", (c) =>
		new CreateBaseModal(plugin, c.name, c.path).open()
	);
}
