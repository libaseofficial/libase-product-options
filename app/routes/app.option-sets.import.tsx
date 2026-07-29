import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  buildPreview,
  executeEasifyImport,
  parseEasifyCsv,
  type PreviewResult,
  type StagedImport,
} from "../lib/easify-import.server";
import {
  deleteStagedImport,
  loadStagedImport,
  saveStagedImport,
} from "../lib/import-storage.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const recentJobs = await prisma.importJob.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  return { recentJobs };
};

type ActionData =
  | { ok: true; stage: "validate"; stagingToken: string; preview: PreviewResult }
  | { ok: true; stage: "cancel" }
  | { ok: false; stage: "validate" | "confirm" | "cancel" | "unknown"; error: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "validate") {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return {
        ok: false,
        stage: "validate",
        error: "CSVファイルを選択してください。",
      } satisfies ActionData;
    }

    const text = await file.text();
    const { headerCheck, rows } = parseEasifyCsv(text);

    if (!headerCheck.ok) {
      return {
        ok: false,
        stage: "validate",
        error: `CSVヘッダーに必須列が不足しています: ${headerCheck.missing.join(", ")}`,
      } satisfies ActionData;
    }
    if (rows.length === 0) {
      return {
        ok: false,
        stage: "validate",
        error: "CSVにデータ行がありません。",
      } satisfies ActionData;
    }

    const preview = buildPreview(rows.length, rows);

    // プレビュー段階ではまだImportJobを作らず、一時ファイルにステージングするだけ。
    // ImportJobはCLIインポートと共通の executeEasifyImport が確定時に作成する。
    const stagingToken = crypto.randomUUID();
    const staged: StagedImport = {
      shop,
      filename: file.name,
      totalRows: rows.length,
      rows,
    };
    await saveStagedImport(stagingToken, staged);

    return {
      ok: true,
      stage: "validate",
      stagingToken,
      preview,
    } satisfies ActionData;
  }

  if (intent === "confirm") {
    const stagingToken = String(formData.get("stagingToken") ?? "");
    const staged = await loadStagedImport(stagingToken);

    if (!staged || staged.shop !== shop) {
      return {
        ok: false,
        stage: "confirm",
        error:
          "インポート内容が見つかりません。お手数ですが再度アップロードしてください。",
      } satisfies ActionData;
    }

    let importJobId: string;
    try {
      const result = await executeEasifyImport({
        shop,
        filename: staged.filename,
        rows: staged.rows,
        totalRows: staged.totalRows,
      });
      importJobId = result.importJobId;
    } catch {
      return {
        ok: false,
        stage: "confirm",
        error: "インポート処理中にエラーが発生しました。インポート履歴を確認してください。",
      } satisfies ActionData;
    }
    await deleteStagedImport(stagingToken);

    return redirect(`/app/option-sets?imported=${importJobId}`);
  }

  if (intent === "cancel") {
    const stagingToken = String(formData.get("stagingToken") ?? "");
    await deleteStagedImport(stagingToken);
    return { ok: true, stage: "cancel" } satisfies ActionData;
  }

  return {
    ok: false,
    stage: "unknown",
    error: "不明な操作です。",
  } satisfies ActionData;
};

export default function ImportOptionSets() {
  const { recentJobs } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();

  const data = fetcher.data;
  const isSubmitting = fetcher.state !== "idle";
  const showingPreview = data?.ok === true && data.stage === "validate";

  return (
    <s-page heading="Easify CSVインポート">
      <s-link slot="breadcrumb-actions" href="/app/option-sets">
        オプションセット一覧
      </s-link>
      {!showingPreview ? (
        <s-section heading="CSVファイルをアップロード">
          <s-paragraph>
            EasifyからエクスポートしたCSVファイルを選択してください。まず内容を検証し、取り込み内容をプレビューします。DBへの登録は次の画面で確定操作をするまで行われません。
          </s-paragraph>
          {data?.ok === false && data.stage === "validate" ? (
            <s-banner tone="critical" heading="検証エラー">
              <s-paragraph>{data.error}</s-paragraph>
            </s-banner>
          ) : null}
          <fetcher.Form method="post" encType="multipart/form-data">
            <input type="hidden" name="intent" value="validate" />
            <s-stack direction="block" gap="base">
              <s-drop-zone
                name="file"
                accept=".csv,text/csv"
                label="Easify CSVファイル"
                required
              ></s-drop-zone>
              <s-button
                type="submit"
                variant="primary"
                {...(isSubmitting ? { loading: true } : {})}
              >
                検証してプレビュー
              </s-button>
            </s-stack>
          </fetcher.Form>
        </s-section>
      ) : (
        <PreviewSection
          preview={data.preview}
          stagingToken={data.stagingToken}
          fetcher={fetcher}
          isSubmitting={isSubmitting}
        />
      )}

      {data?.ok === false && data.stage === "confirm" ? (
        <s-banner tone="critical" heading="インポートエラー">
          <s-paragraph>{data.error}</s-paragraph>
        </s-banner>
      ) : null}

      {recentJobs.length > 0 ? (
        <s-section slot="aside" heading="インポート履歴">
          <s-stack direction="block" gap="small">
            {recentJobs.map((job) => (
              <s-box key={job.id} padding="small" borderWidth="base" borderRadius="base">
                <s-text type="strong">{job.filename}</s-text>
                <s-paragraph>
                  {job.status} ― {new Date(job.createdAt).toLocaleString("ja-JP")}
                </s-paragraph>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      ) : null}
    </s-page>
  );
}

function PreviewSection({
  preview,
  stagingToken,
  fetcher,
  isSubmitting,
}: {
  preview: PreviewResult;
  stagingToken: string;
  fetcher: ReturnType<typeof useFetcher<ActionData>>;
  isSubmitting: boolean;
}) {
  return (
    <s-section heading="インポート内容のプレビュー">
      <s-paragraph>
        全 {preview.totalRows} 行を解析し、{preview.setCount} 件のオプションセットを検出しました。内容を確認し、問題なければ「確定してインポート」を押してください。
      </s-paragraph>

      {preview.warnings.length > 0 ? (
        <s-banner tone="warning" heading="確認事項">
          <s-stack direction="block" gap="small">
            {preview.warnings.map((w, i) => (
              <s-paragraph key={i}>{w}</s-paragraph>
            ))}
          </s-stack>
        </s-banner>
      ) : null}

      <s-table variant="auto">
        <s-table-header-row>
          <s-table-header>セット名</s-table-header>
          <s-table-header format="numeric">項目数</s-table-header>
          <s-table-header format="numeric">選択肢数</s-table-header>
          <s-table-header>対象商品ハンドル</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {preview.sets.map((set) => (
            <s-table-row key={set.easifySetId}>
              <s-table-cell>{set.name}</s-table-cell>
              <s-table-cell>{set.fieldCount}</s-table-cell>
              <s-table-cell>{set.choiceCount}</s-table-cell>
              <s-table-cell>{set.productHandles.join(", ") || "―"}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>

      <s-stack direction="inline" gap="base">
        <s-button
          variant="primary"
          {...(isSubmitting ? { loading: true } : {})}
          onClick={() => {
            const fd = new FormData();
            fd.set("intent", "confirm");
            fd.set("stagingToken", stagingToken);
            fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
          }}
        >
          確定してインポート
        </s-button>
        <s-button
          variant="tertiary"
          {...(isSubmitting ? { loading: true } : {})}
          onClick={() => {
            const fd = new FormData();
            fd.set("intent", "cancel");
            fd.set("stagingToken", stagingToken);
            fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
          }}
        >
          キャンセルしてやり直す
        </s-button>
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
