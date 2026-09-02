import { Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service.js";

import type { GlossarySource, GlossaryTerm } from "./glossary.js";

/**
 * The `memory_entries` reader behind {@link GlossarySource} — the consent gate.
 *
 * B09 owns *writing* memory entries (it is the work package that observes a user
 * correcting a spelling and decides to remember it). A11 owns reading them into
 * a transcription, and reading is where the consent question is actually asked:
 *
 * * an entry is used only while its **consent record is still granted** — the row
 *   carries `consent_id`, and a withdrawal stamps `withdrawn_at` on the grant
 *   (A05, D61/D62), so a withdrawal takes effect on the very next transcription
 *   without anything having to go back and delete rows;
 * * an entry is used only while it is **unexpired** (`expires_at`), which is what
 *   makes memory a retention promise rather than a database;
 * * the query is scoped to one workspace, and the entries of another tenant are
 *   not reachable from here at all.
 *
 * There is deliberately no boolean to pass in. A caller cannot "forget" to check
 * consent, because the check is the query.
 */

/** Memory kinds this reader understands. B09 may add more; unknown kinds are ignored. */
const GLOSSARY_KINDS: Readonly<Record<string, GlossaryTerm["source"]>> = {
  glossary: "glossary",
  glossary_term: "glossary",
  spelling: "spelling",
  name_spelling: "spelling",
};

/** Cap on terms read for one transcription: a glossary, not a dictionary. */
export const MAX_GLOSSARY_TERMS = 500;

@Injectable()
export class MemoryGlossarySource implements GlossarySource {
  private readonly logger = new Logger(MemoryGlossarySource.name);

  constructor(private readonly prisma: PrismaService) {}

  async terms(workspaceId: string): Promise<readonly GlossaryTerm[]> {
    const rows = await this.prisma.memoryEntry.findMany({
      where: {
        workspaceId,
        kind: { in: Object.keys(GLOSSARY_KINDS) },
        expiresAt: { gt: new Date() },
        // The consent record is the gate; a withdrawal closes the grant it wrote.
        consent: { purpose: "memory", granted: true, withdrawnAt: null },
      },
      select: { id: true, kind: true, value: true },
      orderBy: { createdAt: "desc" },
      take: MAX_GLOSSARY_TERMS,
    });

    const terms: GlossaryTerm[] = [];
    for (const row of rows) {
      const source = GLOSSARY_KINDS[row.kind];
      if (source === undefined) continue;
      const term = parseTerm(row.value, source);
      if (term === undefined) {
        this.logger.debug({ entryId: row.id, kind: row.kind }, "memory entry is not a term");
        continue;
      }
      terms.push(term);
    }
    return terms;
  }
}

/**
 * `memory_entries.value` is free-form JSON (B09's `MemoryEntrySchema`), so this
 * reads defensively: `{term}`, `{text}`, `{value}` or a bare string, with optional
 * `aliases`/`variants`. An entry it cannot understand is skipped, never guessed at.
 */
function parseTerm(value: unknown, source: GlossaryTerm["source"]): GlossaryTerm | undefined {
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : { term: value.trim(), source };
  }
  if (typeof value !== "object" || value === null) return undefined;

  const record = value as Record<string, unknown>;
  const text = [record["term"], record["text"], record["value"], record["correct"]].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
  );
  if (text === undefined) return undefined;

  const rawAliases = record["aliases"] ?? record["variants"] ?? record["heard"];
  const aliases = Array.isArray(rawAliases)
    ? rawAliases.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
      )
    : [];

  return aliases.length === 0
    ? { term: text.trim(), source }
    : { term: text.trim(), aliases: aliases.map((alias) => alias.trim()), source };
}
