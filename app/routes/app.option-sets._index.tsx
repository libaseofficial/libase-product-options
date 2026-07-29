import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [optionSets, lastImportJob] = await Promise.all([
    prisma.optionSet.findMany({
      where: { shop },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        _count: { select: { fields: true, productMappings: true } },
      },
    }),
    prisma.importJob.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return { optionSets, lastImportJob };
};

const STATUS_TONE: Record<string, "success" | "info" | "warning"> = {
  active: "success",
  draft: "info",
  archived: "warning",
};

const STATUS_LABEL: Record<string, string> = {
  active: "有効",
  draft: "下書き",
  archived: "アーカイブ",
};

export default function OptionSetsIndex() {
  const { optionSets, lastImportJob } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const justImported = searchParams.get("imported");

  return (
    <s-page heading="オプションセット">
      <s-button slot="primary-action" href="/app/option-sets/import">
        CSVをインポート
      </s-button>

      {justImported && lastImportJob?.id === justImported ? (
        <s-banner tone="success" heading="インポートが完了しました">
          <s-paragraph>
            取込 {lastImportJob.importedRows}件 / スキップ {lastImportJob.skippedRows}件 / 失敗 {lastImportJob.failedRows}件
          </s-paragraph>
        </s-banner>
      ) : null}

      {lastImportJob ? (
        <s-section heading="直近のインポート">
          <s-paragraph>
            {lastImportJob.filename} ―{" "}
            {lastImportJob.status === "completed"
              ? `完了(取込 ${lastImportJob.importedRows ?? 0}件 / スキップ ${lastImportJob.skippedRows}件 / 失敗 ${lastImportJob.failedRows}件)`
              : lastImportJob.status === "failed"
                ? `失敗: ${lastImportJob.errorMessage ?? ""}`
                : lastImportJob.status}{" "}
            ―{" "}
            {new Date(
              lastImportJob.completedAt ?? lastImportJob.createdAt,
            ).toLocaleString("ja-JP")}
          </s-paragraph>
        </s-section>
      ) : null}

      <s-section heading={`オプションセット一覧(${optionSets.length}件)`}>
        {optionSets.length === 0 ? (
          <s-paragraph>
            まだオプションセットがありません。「CSVをインポート」からEasifyのエクスポートCSVを取り込んでください。
          </s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>セット名</s-table-header>
              <s-table-header>ステータス</s-table-header>
              <s-table-header>由来</s-table-header>
              <s-table-header format="numeric">項目数</s-table-header>
              <s-table-header format="numeric">商品数</s-table-header>
              <s-table-header>最終更新</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {optionSets.map((set) => (
                <s-table-row key={set.id} clickDelegate={`set-link-${set.id}`}>
                  <s-table-cell>
                    <s-link id={`set-link-${set.id}`} href={`/app/option-sets/${set.id}`}>
                      {set.name}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[set.status] ?? "info"}>
                      {STATUS_LABEL[set.status] ?? set.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {set.source === "csv" ? "CSV由来" : "手動作成"}
                  </s-table-cell>
                  <s-table-cell>{set._count.fields}</s-table-cell>
                  <s-table-cell>{set._count.productMappings}</s-table-cell>
                  <s-table-cell>
                    {new Date(set.updatedAt).toLocaleString("ja-JP")}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
