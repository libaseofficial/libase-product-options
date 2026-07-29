/**
 * Easify CSVをブラウザ経由でアップロードせず、ローカルファイルから直接DBへインポートするCLI。
 *
 * ブラウザ経由のアップロード(/app/option-sets/import)は、Shopify CLIのdevトンネルが
 * 大容量ファイル(116MB超)を転送できず Cloudflare 502 になるため、その代替として用意する。
 * インポートロジック本体は app/lib/easify-import.server.ts を共有し、
 * ImportJobの作成・結果保存も executeEasifyImport() を通じてブラウザ経路と同じ処理を行う。
 *
 * 使用例:
 *   npm run import:easify -- "/Users/ken/Downloads/easify-product-options-option-sets-2026-07-25.csv"
 *   npm run import:easify -- "/path/to.csv" --shop other-shop.myshopify.com --yes
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import prisma from "../app/db.server";
import {
  buildPreview,
  executeEasifyImport,
  parseEasifyCsv,
} from "../app/lib/easify-import.server";

const DEFAULT_SHOP = "libase-options-dev.myshopify.com";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let shop = DEFAULT_SHOP;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--shop") {
      shop = argv[++i] ?? shop;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg.startsWith("--")) {
      console.error(`未知のオプションです: ${arg}`);
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }

  return { filePath: positional[0], shop, yes };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  const { filePath, shop, yes } = parseArgs(process.argv.slice(2));

  if (!filePath) {
    console.error(
      '使い方: npm run import:easify -- "<CSVファイルパス>" [--shop <shop-domain>] [--yes]',
    );
    process.exitCode = 1;
    return;
  }

  const absPath = path.resolve(filePath);
  const stats = await stat(absPath).catch(() => null);
  if (!stats || !stats.isFile()) {
    console.error(`CSVファイルが見つかりません: ${absPath}`);
    process.exitCode = 1;
    return;
  }

  console.log(`CSVを読み込み中: ${absPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
  const text = await readFile(absPath, "utf-8");

  const { headerCheck, rows } = parseEasifyCsv(text);
  if (!headerCheck.ok) {
    console.error(
      `CSVヘッダーに必須列が不足しています: ${headerCheck.missing.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  if (rows.length === 0) {
    console.error("CSVにデータ行がありません。");
    process.exitCode = 1;
    return;
  }

  const preview = buildPreview(rows.length, rows);

  console.log("");
  console.log("=== プレビュー ===");
  console.log(`shop: ${shop}`);
  console.log(`ファイル: ${path.basename(absPath)}`);
  console.log(`総行数: ${preview.totalRows}`);
  console.log(`検出セット数: ${preview.setCount}`);
  console.log(`重複行(自動的に1件へ統合): ${preview.duplicateRows}`);
  console.log(`未対応タイプの行(スキップ): ${preview.unknownTypeRows}`);
  console.log(`不正行(スキップ): ${preview.invalidRows}`);
  console.log("");
  for (const set of preview.sets) {
    console.log(
      `  [${set.easifySetId}] ${set.name} ― 項目 ${set.fieldCount} / 選択肢 ${set.choiceCount}`,
    );
  }

  if (preview.warnings.length > 0) {
    console.log("");
    console.log("警告:");
    for (const w of preview.warnings) {
      console.log(`  - ${w}`);
    }
  }
  console.log("");

  if (!yes) {
    const ok = await confirm("この内容でインポートを実行しますか? (y/N): ");
    if (!ok) {
      console.log("インポートを中止しました。DBへの書き込みは行われていません。");
      return;
    }
  }

  console.log("インポートを実行しています...");
  const { importJobId, summary, importedRows } = await executeEasifyImport({
    shop,
    filename: path.basename(absPath),
    rows,
    totalRows: rows.length,
  });

  console.log("");
  console.log("=== 完了 ===");
  console.log(`ImportJob ID: ${importJobId}`);
  console.log(`セット作成: ${summary.setsCreated} / セット更新: ${summary.setsUpdated}`);
  console.log(`項目書き込み: ${summary.fieldsWritten}`);
  console.log(`選択肢書き込み: ${summary.choicesWritten}`);
  console.log(
    `取込行数: ${importedRows} / スキップ: ${summary.skippedRows} / 失敗: ${summary.failedRows}`,
  );
}

main()
  .catch((error) => {
    console.error("インポートに失敗しました:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
