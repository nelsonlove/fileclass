/*
 * File / editor context menus (ARCHITECTURE.md §19.3). Adds a single "Fileclass"
 * submenu (like the Blueprint plugin) to right-click menus — on notes (field
 * actions), on `.fileclass` definitions (schema actions), and on folders (create
 * a fileClass here). All actions reuse existing modals/commands — no new write
 * path. A Component so its event listeners are torn down on plugin unload.
 *
 * NOTE — deviation from CLAUDE.md §16 ("private internals only in basesAdapter"):
 * `MenuItem.setSubmenu()` is an untyped-but-stable Obsidian *UI* API (used by many
 * plugins incl. Blueprint), not a fragile Bases internal. It is reached here via a
 * minimal `unknown` cast (SubmenuItem) and kept co-located with the menu code
 * rather than in basesAdapter (Bases-specific, runtime-proven, not to be touched).
 */
import { Component, Menu, Notice, TFile, TFolder } from "obsidian";

import type FileclassPlugin from "../../main";
import { bulkInsertMissingFields } from "../commands/bulkInsertMissing";
import { createFileClassInFolder } from "../commands/createFileClass";
import { insertMissingFields } from "../commands/insertMissingFields";
import { pickAndUpdateField } from "../fields/fieldActions";
import { reorderFrontmatter } from "../io/reorderFrontmatter";
import { reorderPlan } from "../schema/reorder";
import { pickAndCreateBase } from "../views/baseFileGenerator";
import { fileClassBaseFile, openFileClassBase } from "../views/baseSync";
import { insertReverseRelation, vaultHasReverseRelations } from "../views/reverseSync";
import { syncSchemaCanvas } from "../views/schemaCanvasSync";
import { AddFileClassModal } from "./addFileClassModal";
import { openBulkEdit } from "./bulkEditModal";
import { openFileClassSchema } from "./fileClassSchemaModal";
import { NoteFieldsModal } from "./noteFieldsModal";

/** Minimal shape for the private `MenuItem.setSubmenu()` API. */
interface SubmenuItem {
	setSubmenu(): Menu;
}

export class FileclassContextMenu extends Component {
	/** Guards against the editor-menu firing right after a file-menu. */
	private fileMenuOpen = false;

	constructor(private readonly plugin: FileclassPlugin) {
		super();
	}

	onload(): void {
		this.registerEvent(
			this.plugin.app.workspace.on("file-menu", (menu, file) => {
				this.fileMenuOpen = true;
				menu.onHide = () => (this.fileMenuOpen = false);
				if (!this.plugin.settings.enableContextMenu) return;
				if (file instanceof TFolder) this.buildFolderMenu(menu, file);
				else if (file instanceof TFile) this.build(menu, file);
			})
		);
		this.registerEvent(
			this.plugin.app.workspace.on("editor-menu", (menu) => {
				if (this.fileMenuOpen || !this.plugin.settings.enableContextMenu) return;
				const file = this.plugin.app.workspace.getActiveFile();
				if (file) this.build(menu, file);
			})
		);
	}

	/** Adds the "Fileclass" parent item and returns its submenu. */
	private submenu(menu: Menu): Menu {
		let sub: Menu = menu;
		menu.addItem((item) => {
			item.setTitle("Fileclass").setIcon("shapes");
			sub = (item as unknown as SubmenuItem).setSubmenu();
		});
		return sub;
	}

	private build(menu: Menu, file: TFile): void {
		// A `.fileclass` definition (indexed) → schema actions; a note → field actions.
		const fcName = this.plugin.index.fileClassNameOfNote(file.path);
		if (fcName) {
			this.buildFileClassMenu(this.submenu(menu), fcName);
		} else if (file.extension === "md") {
			this.buildNoteMenu(this.submenu(menu), file);
		}
	}

	private buildFolderMenu(menu: Menu, folder: TFolder): void {
		this.submenu(menu).addItem((item) =>
			item
				.setTitle("New fileClass here")
				.setIcon("plus")
				.onClick(() => createFileClassInFolder(this.plugin, folder.path))
		);
	}

	private buildFileClassMenu(menu: Menu, fcName: string): void {
		menu.addItem((item) =>
			item
				.setTitle("Manage this fileClass")
				.setIcon("wrench")
				.onClick(() => openFileClassSchema(this.plugin, fcName))
		);
		const hasBase = !!fileClassBaseFile(this.plugin, fcName);
		menu.addItem((item) =>
			item
				.setTitle(hasBase ? "Modify base for this fileClass" : "Create a base for this fileClass")
				.setIcon("layout-grid")
				.onClick(() => pickAndCreateBase(this.plugin, fcName))
		);
		if (hasBase) {
			menu.addItem((item) =>
				item
					.setTitle("Open base for this fileClass")
					.setIcon("table")
					.onClick(() => openFileClassBase(this.plugin, fcName))
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("Insert missing fields across this fileClass")
				.setIcon("plus")
				.onClick(() => void bulkInsertMissingFields(this.plugin, fcName))
		);
		menu.addItem((item) =>
			item
				.setTitle("Bulk edit a field of this fileClass")
				.setIcon("replace")
				.onClick(() => openBulkEdit(this.plugin, fcName))
		);
		// The model these classes make is not visible anywhere else (#149). Upstream
		// hangs this off the class *folder*; this fork discovers definitions vault-wide
		// and has no such folder, so it lives on the definition itself — which is also
		// where someone asking "how do these relate?" is already looking.
		menu.addItem((item) =>
			item
				.setTitle("Draw the schema canvas")
				.setIcon("git-fork")
				.onClick(() => void syncSchemaCanvas(this.plugin))
		);
	}

	private buildNoteMenu(menu: Menu, file: TFile): void {
		menu.addItem((item) =>
			item
				.setTitle("Manage note fields")
				.setIcon("list")
				.onClick(() => new NoteFieldsModal(this.plugin, file).open())
		);
		menu.addItem((item) =>
			item
				.setTitle("Update a field")
				.setIcon("pencil")
				.onClick(() => pickAndUpdateField(this.plugin, file, this.plugin.index.getFields(file)))
		);
		menu.addItem((item) =>
			item
				.setTitle("Insert missing fields")
				.setIcon("plus")
				.onClick(() =>
					void insertMissingFields(this.plugin.app, file, this.plugin.index.getFields(file))
				)
		);
		// Only when there is something to reorder: an entry that answers "already in order"
		// is an entry that wasted a right-click. The check is one pass over the note's keys
		// against the resolved fields, both already in memory (#104).
		if (this.isOutOfOrder(file)) {
			menu.addItem((item) =>
				item
					.setTitle("Reorder properties")
					.setIcon("arrow-down-up")
					.onClick(() => void this.reorder(file))
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("Add fileClass")
				.setIcon("tag")
				.onClick(() => new AddFileClassModal(this.plugin, file).open())
		);
		// The other end of a relation (#154). Offered on evidence the index can give for free —
		// that some class declares a bound link field — because discovery is a vault scan and a
		// right-click cannot wait for one. It says so itself when nothing points here.
		if (vaultHasReverseRelations(this.plugin)) {
			menu.addItem((item) =>
				item
					.setTitle("Insert notes that point here")
					.setIcon("corner-left-down")
					.onClick(() => void insertReverseRelation(this.plugin, file))
			);
		}
		// One entry per class that applies (#23). Named, not a picker: from here the
		// answer is usually one class, and this is also the only route for a class
		// bound by tag, path or Base view — those leave no value to click in the
		// Properties editor. Same wrench as "Manage this fileClass" on a class note.
		for (const name of this.plugin.index.getFileClasses(file)) {
			menu.addItem((item) =>
				item
					.setTitle(`Open ${name} schema`)
					.setIcon("wrench")
					.onClick(() => openFileClassSchema(this.plugin, name))
			);
		}
	}

	/** Does this note's frontmatter differ from the order its class declares? */
	private isOutOfOrder(file: TFile): boolean {
		const fields = this.plugin.index.getFields(file);
		if (!fields.length) return false;
		const keys = Object.keys(
			this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {}
		);
		return reorderPlan(fields, keys, this.plugin.settings.unknownKeysPosition) !== null;
	}

	private async reorder(file: TFile): Promise<void> {
		const { moved, unpositionable } = await reorderFrontmatter(
			this.plugin.app,
			file,
			this.plugin.index.getFields(file),
			this.plugin.settings.unknownKeysPosition
		);
		if (!moved) return;
		const caveat = unpositionable.length
			? ` (${unpositionable.join(", ")} stays where YAML puts it)`
			: "";
		new Notice(`Fileclass: reordered ${moved} properties${caveat}.`);
	}
}
