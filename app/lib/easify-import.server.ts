import prisma from "../db.server";
import { parseCsv, rowsToRecords } from "./csv.server";

/**
 * Easify Product Options のCSVエクスポート形式に対応する取り込みロジック。
 *
 * CSVの行構造:
 *   option_set_id       -> OptionSetを一意に識別
 *     option_id_unique   -> OptionSetの中でOptionFieldを一意に識別(グループ化キー)
 *       option_value_id  -> OptionFieldの中でOptionChoiceを一意に識別
 *
 * 実データ検証の結果、同一 (option_id_unique, option_value_id) の組み合わせで
 * まったく同じ内容の行が複数回出現することが確認されたため、取り込み時に重複排除する。
 *
 * `live_preview_transform` 列はEasify独自のプレビュー描画用データで、788行中476行が
 * 非空、1フィールド最大1.8MB・合計約113MB(CSV全体の98%)を占める。新アプリのTheme App
 * Extensionはこの形式を使わないため、ユーザー確認の上でDBには保存しない
 * (元CSVファイル自体は変更・削除しないため、データそのものは失われない)。
 */

export const REQUIRED_HEADERS = [
  "option_set_id",
  "option_set_title",
  "option_id_unique",
  "option_type",
  "option_value_id",
] as const;

const HEAVY_COLUMNS = ["live_preview_transform"] as const;

const KNOWN_OPTION_TYPES = [
  "text-box",
  "dropdown",
  "checkbox",
  "product-list",
  "file-upload",
] as const;

// 選択肢(OptionChoice)を持つタイプ。text-box / file-upload は
// Easifyのエクスポート上ダミーの option_value_id 行を持つだけで実際の選択肢ではない。
const CHOICE_TYPES: readonly string[] = ["dropdown", "checkbox", "product-list"];

const SET_EXTRA_KEYS = [
  "customer_tag",
  "apply_type",
  "product_condition",
] as const;

const FIELD_EXTRA_KEYS = [
  "option_id",
  "hidden_label",
  "info_text",
  "multi_select",
  "file_restriction_type",
  "file_extension",
  "switch_label",
  "option_add_on_price",
  "show_price_position",
  "metadata",
  "quantity_label",
  "quantity_price_type",
  "is_in_group",
  "date_time_type",
  "conditions_serialized",
  "date_time_values",
  "is_change_image",
  "column_width",
  "image_size",
  "switch_value",
  "show_selected_values",
  "is_active_option",
  "column_number",
  "show_selected_on_label",
  "quantity_selector",
  "swatches_slider",
  "button_price_position",
  "is_change_label",
  "one_time_charge",
  "metadata_type",
  "is_created",
  "use_price",
  "image_canvas_id",
  "image_canvas_url",
  "additional_data",
  "default_value",
  "label_position",
  "min_value",
  "max_value",
] as const;

const CHOICE_EXTRA_KEYS = [
  "option_value_number_color",
  "option_value_is_default",
  "option_value_image_id",
  "swatch_shape",
  "option_value_color_code",
  "swatch_position",
] as const;

export type SlimRow = Record<string, string>;

export interface StagedImport {
  shop: string;
  filename: string;
  totalRows: number;
  rows: SlimRow[];
}

export interface PreviewFieldSummary {
  easifyFieldId: string;
  type: string;
  label: string;
  choiceCount: number;
  recognizedType: boolean;
}

export interface PreviewSetSummary {
  easifySetId: string;
  name: string;
  productHandles: string[];
  fieldCount: number;
  choiceCount: number;
  fields: PreviewFieldSummary[];
}

export interface PreviewResult {
  totalRows: number;
  setCount: number;
  sets: PreviewSetSummary[];
  duplicateRows: number;
  unknownTypeRows: number;
  invalidRows: number;
  warnings: string[];
}

export interface ImportSummary {
  setsCreated: number;
  setsUpdated: number;
  fieldsWritten: number;
  choicesWritten: number;
  skippedRows: number;
  failedRows: number;
}

function pickExtra(row: SlimRow, keys: readonly string[]): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== "") {
      extra[key] = value;
    }
  }
  return extra;
}

function parseBoolFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function parseIntSafe(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function parseProductHandles(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // Not valid JSON, ignore.
  }
  return [];
}

export interface ValidateHeadersResult {
  ok: boolean;
  missing: string[];
  headers: string[];
}

export function validateHeaders(headers: string[]): ValidateHeadersResult {
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  return { ok: missing.length === 0, missing, headers };
}

/**
 * アップロードされたCSV全文をパースし、DBには重い列を含めないスリムな行の配列を返す。
 */
export function parseEasifyCsv(text: string): {
  headerCheck: ValidateHeadersResult;
  rows: SlimRow[];
} {
  const parsedRows = parseCsv(text);
  const { headers, records } = rowsToRecords(parsedRows);
  const headerCheck = validateHeaders(headers);

  const rows: SlimRow[] = records.map((record) => {
    const slim: SlimRow = {};
    for (const key of Object.keys(record)) {
      if ((HEAVY_COLUMNS as readonly string[]).includes(key)) continue;
      slim[key] = record[key];
    }
    return slim;
  });

  return { headerCheck, rows };
}

interface GroupedField {
  easifyFieldId: string;
  order: number;
  firstRow: SlimRow;
  type: string;
  recognizedType: boolean;
  choices: Map<string, { order: number; row: SlimRow }>;
}

interface GroupedSet {
  easifySetId: string;
  order: number;
  firstRow: SlimRow;
  fields: Map<string, GroupedField>;
}

function groupRows(rows: SlimRow[]): {
  sets: Map<string, GroupedSet>;
  duplicateRows: number;
  unknownTypeRows: number;
  invalidRows: number;
} {
  const sets = new Map<string, GroupedSet>();
  let duplicateRows = 0;
  let unknownTypeRows = 0;
  let invalidRows = 0;
  let setOrder = 0;

  for (const row of rows) {
    const easifySetId = row.option_set_id?.trim();
    const easifyFieldId = row.option_id_unique?.trim();
    if (!easifySetId || !easifyFieldId) {
      invalidRows++;
      continue;
    }

    let set = sets.get(easifySetId);
    if (!set) {
      set = {
        easifySetId,
        order: setOrder++,
        firstRow: row,
        fields: new Map(),
      };
      sets.set(easifySetId, set);
    }

    const type = row.option_type?.trim() ?? "";
    let field = set.fields.get(easifyFieldId);
    if (!field) {
      const recognizedType = (KNOWN_OPTION_TYPES as readonly string[]).includes(type);
      if (!recognizedType) unknownTypeRows++;
      field = {
        easifyFieldId,
        order: set.fields.size,
        firstRow: row,
        type,
        recognizedType,
        choices: new Map(),
      };
      set.fields.set(easifyFieldId, field);
    }

    if (!field.recognizedType) continue;
    if (!CHOICE_TYPES.includes(field.type)) continue;

    const easifyChoiceId = row.option_value_id?.trim();
    if (!easifyChoiceId) continue;

    if (field.choices.has(easifyChoiceId)) {
      duplicateRows++;
      continue;
    }
    field.choices.set(easifyChoiceId, { order: field.choices.size, row });
  }

  return { sets, duplicateRows, unknownTypeRows, invalidRows };
}

export function buildPreview(
  totalRows: number,
  rows: SlimRow[],
): PreviewResult {
  const { sets, duplicateRows, unknownTypeRows, invalidRows } = groupRows(rows);
  const warnings: string[] = [];

  if (invalidRows > 0) {
    warnings.push(
      `option_set_id または option_id_unique が空の行が ${invalidRows} 件あり、スキップされます。`,
    );
  }
  if (unknownTypeRows > 0) {
    warnings.push(
      `未対応の option_type を含む項目が ${unknownTypeRows} 件あります(対応タイプ: ${KNOWN_OPTION_TYPES.join(", ")})。これらは今回インポートされません。`,
    );
  }
  if (duplicateRows > 0) {
    warnings.push(
      `重複した選択肢行が ${duplicateRows} 件検出され、自動的に1件へ統合されます。`,
    );
  }

  const setSummaries: PreviewSetSummary[] = Array.from(sets.values())
    .sort((a, b) => a.order - b.order)
    .map((set) => {
      const fields = Array.from(set.fields.values()).sort(
        (a, b) => a.order - b.order,
      );
      const fieldSummaries: PreviewFieldSummary[] = fields.map((f) => ({
        easifyFieldId: f.easifyFieldId,
        type: f.type,
        label: f.firstRow.option_label || f.firstRow.option_name || f.easifyFieldId,
        choiceCount: f.choices.size,
        recognizedType: f.recognizedType,
      }));
      return {
        easifySetId: set.easifySetId,
        name: set.firstRow.option_set_title || set.easifySetId,
        productHandles: parseProductHandles(set.firstRow.option_set_products),
        fieldCount: fieldSummaries.filter((f) => f.recognizedType).length,
        choiceCount: fieldSummaries.reduce((sum, f) => sum + f.choiceCount, 0),
        fields: fieldSummaries,
      };
    });

  return {
    totalRows,
    setCount: setSummaries.length,
    sets: setSummaries,
    duplicateRows,
    unknownTypeRows,
    invalidRows,
    warnings,
  };
}

/**
 * ステージング済みのCSV行をPrisma DBへトランザクションでupsertする。
 * 既存の easifySetId / easifyFieldId / easifyChoiceId と照合するため、
 * 同じCSVを再インポートしても重複レコードは作られない。
 */
export async function runImport(staged: StagedImport): Promise<ImportSummary> {
  const { shop, rows } = staged;
  const { sets, duplicateRows, unknownTypeRows, invalidRows } = groupRows(rows);

  const summary: ImportSummary = {
    setsCreated: 0,
    setsUpdated: 0,
    fieldsWritten: 0,
    choicesWritten: 0,
    skippedRows: duplicateRows,
    failedRows: invalidRows + unknownTypeRows,
  };

  await prisma.$transaction(
    async (tx) => {
      for (const set of sets.values()) {
        const setSettings = {
          ...pickExtra(set.firstRow, SET_EXTRA_KEYS),
          option_set_products: set.firstRow.option_set_products ?? "",
        };

        const existing = await tx.optionSet.findUnique({
          where: { shop_easifySetId: { shop, easifySetId: set.easifySetId } },
        });

        const optionSet = await tx.optionSet.upsert({
          where: { shop_easifySetId: { shop, easifySetId: set.easifySetId } },
          create: {
            shop,
            name: set.firstRow.option_set_title || set.easifySetId,
            easifySetId: set.easifySetId,
            status: "draft",
            source: "csv",
            sortOrder: set.order,
            settingsJson: JSON.stringify(setSettings),
          },
          update: {
            name: set.firstRow.option_set_title || set.easifySetId,
            source: "csv",
            settingsJson: JSON.stringify(setSettings),
          },
        });

        if (existing) {
          summary.setsUpdated++;
        } else {
          summary.setsCreated++;
        }

        for (const field of set.fields.values()) {
          if (!field.recognizedType) continue;

          const isTextBox = field.type === "text-box";
          const minLength = isTextBox ? parseIntSafe(field.firstRow.min_value) : null;
          const maxLength = isTextBox ? parseIntSafe(field.firstRow.max_value) : null;

          const fieldSettings = pickExtra(field.firstRow, FIELD_EXTRA_KEYS);

          const optionField = await tx.optionField.upsert({
            where: {
              optionSetId_easifyFieldId: {
                optionSetId: optionSet.id,
                easifyFieldId: field.easifyFieldId,
              },
            },
            create: {
              optionSetId: optionSet.id,
              easifyFieldId: field.easifyFieldId,
              type: field.type,
              label:
                field.firstRow.option_label ||
                field.firstRow.option_name ||
                field.easifyFieldId,
              name: field.firstRow.option_name || null,
              helpText: field.firstRow.help_text || field.firstRow.info_text || null,
              placeholder: field.firstRow.placeholder || null,
              required: parseBoolFlag(field.firstRow.is_required),
              minLength,
              maxLength,
              sortOrder: field.order,
              settingsJson: JSON.stringify(fieldSettings),
            },
            update: {
              type: field.type,
              label:
                field.firstRow.option_label ||
                field.firstRow.option_name ||
                field.easifyFieldId,
              name: field.firstRow.option_name || null,
              helpText: field.firstRow.help_text || field.firstRow.info_text || null,
              placeholder: field.firstRow.placeholder || null,
              required: parseBoolFlag(field.firstRow.is_required),
              minLength,
              maxLength,
              settingsJson: JSON.stringify(fieldSettings),
            },
          });
          summary.fieldsWritten++;

          for (const choice of field.choices.values()) {
            const row = choice.row;
            const label = row.option_value_label || row.option_value_id;
            const choiceSettings = pickExtra(row, CHOICE_EXTRA_KEYS);

            await tx.optionChoice.upsert({
              where: {
                optionFieldId_easifyChoiceId: {
                  optionFieldId: optionField.id,
                  easifyChoiceId: row.option_value_id,
                },
              },
              create: {
                optionFieldId: optionField.id,
                easifyChoiceId: row.option_value_id,
                label,
                value: label,
                sortOrder: choice.order,
                priceAdjustment: parseIntSafe(row.option_value_add_on_price) ?? 0,
                imageUrl: row.option_value_image_url || null,
                settingsJson: JSON.stringify(choiceSettings),
              },
              update: {
                label,
                value: label,
                priceAdjustment: parseIntSafe(row.option_value_add_on_price) ?? 0,
                imageUrl: row.option_value_image_url || null,
                settingsJson: JSON.stringify(choiceSettings),
              },
            });
            summary.choicesWritten++;
          }
        }
      }
    },
    { timeout: 60_000 },
  );

  return summary;
}

export interface ExecuteImportResult {
  importJobId: string;
  summary: ImportSummary;
  importedRows: number;
}

/**
 * ImportJobの作成〜インポート実行〜結果保存までを一括で行う。
 * ブラウザアップロード(プレビュー確定時)とCLIインポートコマンドの両方から共有される。
 */
export async function executeEasifyImport(params: {
  shop: string;
  filename: string;
  rows: SlimRow[];
  totalRows: number;
}): Promise<ExecuteImportResult> {
  const importJob = await prisma.importJob.create({
    data: {
      shop: params.shop,
      filename: params.filename,
      status: "importing",
      totalRows: params.totalRows,
    },
  });

  try {
    const summary = await runImport({
      shop: params.shop,
      filename: params.filename,
      totalRows: params.totalRows,
      rows: params.rows,
    });
    const importedRows = Math.max(
      params.totalRows - summary.skippedRows - summary.failedRows,
      0,
    );

    await prisma.importJob.update({
      where: { id: importJob.id },
      data: {
        status: "completed",
        importedRows,
        skippedRows: summary.skippedRows,
        failedRows: summary.failedRows,
        summaryJson: JSON.stringify(summary),
        completedAt: new Date(),
      },
    });

    return { importJobId: importJob.id, summary, importedRows };
  } catch (error) {
    await prisma.importJob.update({
      where: { id: importJob.id },
      data: {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}
