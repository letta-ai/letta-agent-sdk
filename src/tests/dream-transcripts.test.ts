import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectTranscripts,
  type Transcript,
} from "../dream/transcripts.js";
import type { NormalizedRecord } from "../dream/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dream-transcripts-"));
  roots.push(root);
  return root;
}

function records(
  label: string,
  startTime: string,
  endTime: string,
): NormalizedRecord[] {
  return [
    { role: "meta", source: "fixture", cwd: `/repo/${label}` },
    { role: "user", content: `request:${label}`, timestamp: startTime },
    { role: "assistant", content: `response:${label}`, timestamp: endTime },
  ];
}

async function transcriptFile(
  dir: string,
  name: string,
  startTime: string,
  endTime: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  await writeFile(
    path,
    `${JSON.stringify(records(name, startTime, endTime), null, 2)}\n`,
    "utf-8",
  );
  return path;
}

function ids(transcripts: Transcript[]): string[] {
  return transcripts.map((transcript) => transcript.session.sessionId);
}

describe("collectTranscripts", () => {
  test("uses an exclusive endTime cutoff and a limit per source spec", async () => {
    const root = tempRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    await transcriptFile(
      first,
      "at-boundary",
      "2026-01-01T23:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
    await transcriptFile(
      first,
      "first-mid",
      "2026-01-03T00:00:00.000Z",
      "2026-01-03T01:00:00.000Z",
    );
    await transcriptFile(
      first,
      "first-new",
      "2026-01-05T00:00:00.000Z",
      "2026-01-05T01:00:00.000Z",
    );
    await transcriptFile(
      first,
      "first-newest",
      "2026-01-06T00:00:00.000Z",
      "2026-01-06T01:00:00.000Z",
    );
    await transcriptFile(
      second,
      "second-old",
      "2026-01-02T12:00:00.000Z",
      "2026-01-02T13:00:00.000Z",
    );
    await transcriptFile(
      second,
      "second-new",
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T01:00:00.000Z",
    );

    const result = await collectTranscripts({
      after: "2026-01-02T00:00:00.000Z",
      sources: [
        { type: "transcript", locator: first, limit: 2 },
        { type: "transcript", locator: second, limit: 1 },
      ],
    });

    // Each source gets its own limit, then results are returned oldest first.
    expect(ids(result)).toEqual([
      "second-new",
      "first-new",
      "first-newest",
    ]);
  });

  test("keeps a straddling session whole and returns a normalized snapshot", async () => {
    const root = tempRoot();
    const path = await transcriptFile(
      root,
      "straddles",
      "2026-01-01T23:59:00.000Z",
      "2026-01-02T00:01:00.000Z",
    );

    const [result] = await collectTranscripts({
      after: new Date("2026-01-02T00:00:00.000Z"),
      sources: [{ type: "transcript", locator: path }],
    });

    expect(result?.session.startTime).toBe("2026-01-01T23:59:00.000Z");
    expect(result?.session.endTime).toBe("2026-01-02T00:01:00.000Z");
    expect(result?.session.recordCount).toBe(2);
    expect(result?.session.cwd).toBe("/repo/straddles");
    expect(result?.records[1]?.content).toBe("request:straddles");

    // The returned transcript is an in-memory snapshot, not a lazy file view.
    await writeFile(path, "[]\n", "utf-8");
    expect(result?.records[2]?.content).toBe("response:straddles");
  });

  test("a file locator selects exactly that transcript", async () => {
    const root = tempRoot();
    const selected = await transcriptFile(
      root,
      "selected",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T01:00:00.000Z",
    );
    await transcriptFile(
      root,
      "later-neighbor",
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T01:00:00.000Z",
    );

    const result = await collectTranscripts({
      sources: [{ type: "transcript", locator: selected }],
    });

    expect(ids(result)).toEqual(["selected"]);
  });

  test("deduplicates overlapping specs and orders timestamp ties deterministically", async () => {
    const root = tempRoot();
    const a = await transcriptFile(
      root,
      "a",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T01:00:00.000Z",
    );
    const b = await transcriptFile(
      root,
      "b",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T01:00:00.000Z",
    );

    const result = await collectTranscripts({
      sources: [
        { type: "transcript", locator: b },
        { type: "transcript", locator: root },
        { type: "transcript", locator: a },
      ],
    });

    expect(ids(result)).toEqual(["a", "b"]);
  });

  test("returns fewer than the limit when fewer transcripts are eligible", async () => {
    const root = tempRoot();
    await transcriptFile(
      root,
      "only",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T01:00:00.000Z",
    );
    expect(
      ids(
        await collectTranscripts({
          sources: [{ type: "transcript", locator: root, limit: 5 }],
        }),
      ),
    ).toEqual(["only"]);
  });

  test("rejects invalid cutoffs and limits", async () => {
    const root = tempRoot();
    await transcriptFile(
      root,
      "one",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T01:00:00.000Z",
    );

    await expect(
      collectTranscripts({
        after: "not-a-date",
        sources: [{ type: "transcript", locator: root }],
      }),
    ).rejects.toThrow(/Invalid transcript cutoff/);

    for (const limit of [0, -1, 1.5]) {
      await expect(
        collectTranscripts({
          sources: [{ type: "transcript", locator: root, limit }],
        }),
      ).rejects.toThrow(/limit must be a positive integer/);
    }
  });
});
