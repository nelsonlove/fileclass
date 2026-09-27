/*
 * Which fields a note is missing. Extracted from insertMissingFields so the
 * Properties action button can name the count without touching the note — same
 * definition of "missing" on both sides, or the button would lie.
 */
import { afterEach, describe, expect, it } from "vitest";

import type FileclassPlugin from "../../main";
import { missingRootFields, settingsScope } from "../../src/fields/missingFields";
import { clearPlugin, setPlugin } from "../../src/globals";
import { Field, FieldType } from "../../src/schema/field";

/** A plugin stand-in carrying nothing but the one setting the scope reads. */
const pluginWith = (insertRequiredFieldsOnly: boolean): FileclassPlugin =>
	({ settings: { insertRequiredFieldsOnly } }) as unknown as FileclassPlugin;

const field = (name: string, extra: Partial<Field> = {}): Field =>
	({
		name,
		id: name,
		type: "Input" as FieldType,
		options: {},
		path: "",
		fileClassName: "Book",
		...extra,
	}) as Field;

const none = () => false;

describe("missingRootFields", () => {
	it("returns the fields the note doesn't carry, in declaration order", () => {
		const fields = [field("publisher"), field("pages"), field("genre")];
		const present = (f: Field) => f.name === "pages";
		expect(missingRootFields(fields, present).map((f) => f.name)).toEqual([
			"publisher",
			"genre",
		]);
	});

	it("is empty when the note carries everything", () => {
		expect(missingRootFields([field("publisher")], () => true)).toEqual([]);
	});

	it("skips nested fields — only root fields are inserted", () => {
		const fields = [field("author"), field("first name", { path: "author" })];
		expect(missingRootFields(fields, none).map((f) => f.name)).toEqual(["author"]);
	});

	it("counts a name shared by two fileClasses once", () => {
		const fields = [field("pages"), field("pages", { fileClassName: "Comic", id: "other" })];
		expect(missingRootFields(fields, none)).toHaveLength(1);
	});

	it("keeps the first of two same-named fields, so its type decides the default", () => {
		const fields = [
			field("pages", { type: "Number" as FieldType }),
			field("pages", { type: "Input" as FieldType, id: "other" }),
		];
		expect(missingRootFields(fields, none)[0].type).toBe("Number");
	});

	it("has nothing to report for a note with no fields", () => {
		expect(missingRootFields([], none)).toEqual([]);
	});

	/*
	 * The `requiredOnly` scope (the "Insert only required fields" preference). The default is the
	 * behaviour above — every root field — so these all pass the scope explicitly.
	 */
	describe("requiredOnly", () => {
		const req = (name: string, extra: Partial<Field> = {}): Field =>
			field(name, { options: { required: true }, ...extra });

		it("keeps only the fields their class marks required", () => {
			const fields = [field("publisher"), req("title"), field("pages")];
			expect(missingRootFields(fields, none, { requiredOnly: true }).map((f) => f.name)).toEqual([
				"title",
			]);
		});

		it("reads `required: \"true\"` as required too, as the validator does", () => {
			const fields = [field("title", { options: { required: "true" } })];
			expect(missingRootFields(fields, none, { requiredOnly: true })).toHaveLength(1);
		});

		it("treats a values-list options array as optional — a list carries no required flag", () => {
			const fields = [field("genre", { options: ["novel", "essay"] })];
			expect(missingRootFields(fields, none, { requiredOnly: true })).toEqual([]);
		});

		it("still skips a required field the note already carries", () => {
			expect(missingRootFields([req("title")], () => true, { requiredOnly: true })).toEqual([]);
		});

		it("still skips a nested required field — only root fields are inserted", () => {
			const fields = [req("author"), req("first name", { path: "author" })];
			expect(missingRootFields(fields, none, { requiredOnly: true }).map((f) => f.name)).toEqual([
				"author",
			]);
		});

		it("keeps a name one class requires and another does not, whichever is declared first", () => {
			const optionalFirst = [field("pages"), req("pages", { id: "other", fileClassName: "Comic" })];
			const requiredFirst = [req("pages"), field("pages", { id: "other", fileClassName: "Comic" })];
			expect(missingRootFields(optionalFirst, none, { requiredOnly: true })).toHaveLength(1);
			expect(missingRootFields(requiredFirst, none, { requiredOnly: true })).toHaveLength(1);
		});

		it("leaves everything in place when the scope is off", () => {
			const fields = [field("publisher"), req("title")];
			expect(missingRootFields(fields, none, { requiredOnly: false })).toHaveLength(2);
			expect(missingRootFields(fields, none, {})).toHaveLength(2);
		});
	});
});

describe("settingsScope", () => {
	afterEach(() => clearPlugin());

	it("asks for every field when the plugin is not loaded", () => {
		expect(settingsScope()).toEqual({ requiredOnly: false });
	});

	it("follows the preference once it is", () => {
		setPlugin(pluginWith(true));
		expect(settingsScope()).toEqual({ requiredOnly: true });
		clearPlugin();
		setPlugin(pluginWith(false));
		expect(settingsScope()).toEqual({ requiredOnly: false });
	});

	/*
	 * The seam that matters: the default of `missingRootFields` is this scope, so the count on the
	 * Properties button and the write behind it cannot disagree — neither passes one.
	 */
	it("is what missingRootFields uses when no scope is given", () => {
		const fields = [field("publisher"), field("title", { options: { required: true } })];
		expect(missingRootFields(fields, none)).toHaveLength(2);
		setPlugin(pluginWith(true));
		expect(missingRootFields(fields, none).map((f) => f.name)).toEqual(["title"]);
	});
});
