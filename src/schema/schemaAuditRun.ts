/*
 * Running the schema audit against the real vault (#159).
 *
 * The rules are in `schemaAudit.ts`, injected with a world so they can be tested without one. This
 * builds that world, walks the classes, logs what it finds and says one sentence about it.
 *
 * Run **once per session** after the first index build, and on demand from a command. Not on every
 * rebuild: the index rebuilds on any change to any class note, and a sweep on each would log the
 * same broken path forty times while somebody edits a schema.
 */
import { Notice, TFile, TFolder } from "obsidian";

import type FileclassPlugin from "../../main";
import { LogEntry, logStamp } from "../log/logLine";
import { logEvents, readSchemaLog } from "../log/schemaLog";
import { isRootField } from "./field";
import {
	AuditWorld,
	AuditedClass,
	Finding,
	auditClass,
	describeAudit,
	diffFindings,
	findingLabel,
	fingerprint,
} from "./schemaAudit";

/** One class as the audit reads it, straight from the parsed schema, with its file. */
interface AuditedEntry {
	cls: AuditedClass;
	path: string;
}

/**
 * Every class as the audit reads it — the root's, then each scope's (§10.3) — straight from the
 * parsed schema.
 */
function auditedClasses(plugin: FileclassPlugin): AuditedEntry[] {
	const out: AuditedEntry[] = [];
	const entries = plugin.index.allClasses();
	// The root's first, in the index's own order: a vault with no scopes reports as it always did.
	const ordered = [...entries.filter((e) => e.scope === ""), ...entries.filter((e) => e.scope !== "")];
	for (const { name, path } of ordered) {
		const parsed = plugin.index.getFileClassByPath(path);
		if (!parsed) continue;
		out.push({
			path,
			cls: {
				name,
				extends: parsed.options.extends,
				excludes: parsed.options.excludes,
				mapWithTag: parsed.options.mapWithTag,
				tagNames: parsed.options.tagNames,
				filesPaths: parsed.options.filesPaths,
				baseFile: parsed.options.baseFile,
				// Own fields: an inherited one belongs to the class that declared it, and reporting it
				// on every child would turn one broken path into a list of them.
				fields: parsed.fields.map((f) => ({
					name: f.name,
					options: (typeof f.options === "object" && !Array.isArray(f.options) ? f.options : {}) as Record<
						string,
						unknown
					>,
				})),
			},
		});
	}
	return out;
}

/**
 * The vault as one class sees it: `extends` resolves from the class's own scope upward (§10.3), so
 * the names it may extend are those its scope sees.
 */
function world(plugin: FileclassPlugin, classPath: string): AuditWorld {
	const index = plugin.index;
	const reachable = new Set(index.fileClassNamesFor(classPath));
	return {
		fileExists: (path) => plugin.app.vault.getAbstractFileByPath(path) instanceof TFile,
		folderExists: (path) => plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder,
		knownClasses: reachable,
		// The whole chain's own fields, which is what this class inherits and therefore what its
		// `excludes` may name — the direct parent alone flagged a grandparent's field as a mistake.
		inheritedFieldNames: () =>
			index
				.ancestorPathsOf(classPath)
				.flatMap((ancestor) => index.getFileClassByPath(ancestor)?.fields ?? [])
				.filter((f) => isRootField(f))
				.map((f) => f.name),
	};
}

/** Every problem the vault's schemas have right now. */
export function auditSchemas(plugin: FileclassPlugin): Finding[] {
	return auditedClasses(plugin).flatMap(({ cls, path }) => auditClass(cls, world(plugin, path)));
}

/**
 * Sweeps, logs, and says one sentence.
 *
 * `announce` separates the two callers. The command always says something, "everything resolves"
 * included — a check that answered silence would leave you wondering whether it ran. The automatic
 * pass speaks only when there is something to say, since a vault that opens with a clean bill of
 * health should just open.
 */
export async function runSchemaAudit(plugin: FileclassPlugin, announce: boolean): Promise<Finding[]> {
	const findings = auditSchemas(plugin);

	// Only what changed since the log last heard about it: a sweep per session that re-listed the
	// same twelve problems would drown the one line saying something *moved*, and the retention cap
	// would then rotate away real history to store copies.
	//
	// The live file only — a rotation therefore restates the standing problems once, which is what a
	// fresh file should say: it opens on where things stand, not on a history it no longer holds.
	const { fresh, resolved } = diffFindings(await readSchemaLog(plugin), findings);
	const stamp = logStamp(new Date());
	const entries: LogEntry[] = [
		...fresh.map((f) => ({
			stamp,
			level: f.level,
			event: `schema.${f.kind}`,
			message: `${findingLabel(f)}: "${f.value}" — ${f.consequence}`,
			details: {
				fileClass: f.fileClass,
				...(f.field ? { field: f.field } : {}),
				value: f.value,
				fingerprint: fingerprint(f),
			},
		})),
		// A problem going away is worth a line too: the file is then a record of what happened, not
		// a snapshot of what is wrong.
		...resolved.map((fp) => ({
			stamp,
			level: "INFO" as const,
			event: "schema.resolved",
			message: `${fp.split("|")[1]}${fp.split("|")[2] ? ` › ${fp.split("|")[2]}` : ""}: "${fp.split("|")[3]}" — fixed`,
			details: { fileClass: fp.split("|")[1], fingerprint: fp },
		})),
	];
	await logEvents(plugin, entries);
	if (announce) new Notice(describeAudit(findings));
	else if (findings.length) {
		// Unasked-for, so it stays short and points at where the detail is.
		new Notice(describeAudit(findings), 10000);
	}
	return findings;
}
