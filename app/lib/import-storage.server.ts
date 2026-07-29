import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { StagedImport } from "./easify-import.server";

const STAGING_DIR = path.join(process.cwd(), "tmp", "imports");

async function ensureDir() {
  await mkdir(STAGING_DIR, { recursive: true });
}

function fileFor(importJobId: string) {
  return path.join(STAGING_DIR, `${importJobId}.json`);
}

export async function saveStagedImport(
  importJobId: string,
  staged: StagedImport,
) {
  await ensureDir();
  await writeFile(fileFor(importJobId), JSON.stringify(staged), "utf-8");
}

export async function loadStagedImport(
  importJobId: string,
): Promise<StagedImport | null> {
  try {
    const text = await readFile(fileFor(importJobId), "utf-8");
    return JSON.parse(text) as StagedImport;
  } catch {
    return null;
  }
}

export async function deleteStagedImport(importJobId: string) {
  await rm(fileFor(importJobId), { force: true });
}
