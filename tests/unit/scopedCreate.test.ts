/*
 * "Create a class" with scoped classes (§10.3): the class lands in the chosen scope's classes
 * folder, with the type that makes it a class there. The modals are replaced by recorders, so the
 * test answers them as a reader would.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const asked: { prompt?: { onSubmit: (v: string) => void }; choice?: { choices: unknown[]; onPick: (c: unknown) => void } } = {};
vi.mock("../../src/fields/input/valueModals", () => ({
	PromptModal: class {
		constructor(_app: unknown, opts: { onSubmit: (v: string) => void }) {
			asked.prompt = opts;
		}
		open(): void {}
	},
	ChoiceSuggestModal: class {
		constructor(_app: unknown, choices: unknown[], _toText: unknown, onPick: (c: unknown) => void) {
			asked.choice = { choices, onPick };
		}
		open(): void {}
	},
}));
const opened: string[] = [];
vi.mock("../../src/ui/fileClassSchemaModal", () => ({
	FileClassSchemaModal: class {
		constructor(_plugin: unknown, _name: string, file: { path: string }) {
			opened.push(file.path);
		}
		open(): void {}
	},
}));

import type FileclassPlugin from "../../main";
import { createFileClass, newClassContent, scopeChoices } from "../../src/commands/createFileClass";
import { fixture, indexOver } from "./scopedFixture";

const flush = () => new Promise((r) => setTimeout(r, 0));

function pluginOver(enableScopedClasses: boolean) {
	const over = indexOver(fixture(), { enableScopedClasses });
	const plugin = { app: over.app, index: over.index, settings: over.settings } as unknown as FileclassPlugin;
	return { ...over, plugin };
}

beforeEach(() => {
	asked.prompt = undefined;
	asked.choice = undefined;
	opened.length = 0;
});

describe("Create a class", () => {
	it("with the setting off, writes into the root folder, as before", async () => {
		const { plugin, created } = pluginOver(false);
		createFileClass(plugin);
		expect(asked.choice).toBeUndefined();
		asked.prompt?.onSubmit("journal");
		await flush();
		expect(created).toEqual([{ path: "Classes/Journal.md", data: "---\nfields: []\n---\n" }]);
		expect(opened).toEqual(["Classes/Journal.md"]);
	});

	it("asks which scope, the active note's first, and writes into that scope's classes folder", async () => {
		const { plugin, created, active, file } = pluginOver(true);
		active.file = file("40 F/ledger.md");
		createFileClass(plugin);
		const choices = asked.choice?.choices as { scope: string; folder: string }[];
		expect(choices[0]).toMatchObject({ scope: "40 F/40 F.md", folder: "40 F/40.03 Shapes/classes" });
		expect(choices[1]).toMatchObject({ scope: "", folder: "Classes" });
		asked.choice?.onPick(choices[0]);
		asked.prompt?.onSubmit("budget");
		await flush();
		expect(created).toEqual([
			{ path: "40 F/40.03 Shapes/classes/Budget.md", data: "---\ntype: Meta/Fileclass\nfields: []\n---\n" },
		]);
		expect(opened).toEqual(["40 F/40.03 Shapes/classes/Budget.md"]);
	});

	it("an area's class goes to its management category's folder", () => {
		const { plugin } = pluginOver(true);
		const area = scopeChoices(plugin).find((c) => c.scope === "70-79 H/70-79 H.md");
		expect(area?.folder).toBe("70-79 H/70 M/70.03 Shapes/classes");
	});

	it("a classes folder's own menu skips the question", async () => {
		const { plugin, created } = pluginOver(true);
		createFileClass(plugin, { folder: "70-79 H/70 M/70.03 Shapes/classes" });
		expect(asked.choice).toBeUndefined();
		asked.prompt?.onSubmit("Recital");
		await flush();
		expect(created[0].path).toBe("70-79 H/70 M/70.03 Shapes/classes/Recital.md");
		expect(created[0].data).toContain("type: Meta/Fileclass");
	});

	it("an existing class is opened, never overwritten", async () => {
		const { plugin, created } = pluginOver(true);
		createFileClass(plugin, { folder: "70-79 H/70 M/70.03 Shapes/classes" });
		asked.prompt?.onSubmit("score");
		await flush();
		expect(created).toEqual([]);
		expect(opened).toEqual(["70-79 H/70 M/70.03 Shapes/classes/Score.md"]);
	});

	it("the type key is the configured one", () => {
		expect(newClassContent(true, "fileClass")).toBe("---\nfileClass: Meta/Fileclass\nfields: []\n---\n");
		expect(newClassContent(false, "fileClass")).toBe("---\nfields: []\n---\n");
	});
});
