import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { data, useFetcher, useLoaderData } from "react-router";
import { boundary, type AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  InsufficientScopeError,
  MetafieldDefinitionError,
  syncOptionSetProducts,
} from "../lib/metafield-sync.server";
import { unsupportedFieldTypes } from "../lib/option-field-types";

const SCOPE_ERROR_MESSAGE =
  "Shopifyへのアクセス権限が不足しているため、商品情報を更新できませんでした。管理画面をいったん閉じて開き直し、アプリのアクセス許可を承認し直してください。";

export interface LinkedVariantInfo {
  variantId: string;
  variantTitle: string;
  price: string;
  productId: string;
  productTitle: string;
}

async function loadLinkedVariants(
  admin: AdminApiContext,
  variantIds: string[],
): Promise<Record<string, LinkedVariantInfo>> {
  if (variantIds.length === 0) return {};

  const response = await admin.graphql(
    `#graphql
    query LibaseGetLinkedVariants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          title
          price
          product { id title }
        }
      }
    }`,
    { variables: { ids: variantIds } },
  );
  const json = await response.json();
  const nodes: Array<{
    id: string;
    title: string;
    price: string;
    product: { id: string; title: string };
  } | null> = json.data?.nodes ?? [];

  const result: Record<string, LinkedVariantInfo> = {};
  for (const node of nodes) {
    if (!node) continue;
    result[node.id] = {
      variantId: node.id,
      variantTitle: node.title,
      price: node.price,
      productId: node.product.id,
      productTitle: node.product.title,
    };
  }
  return result;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const optionSet = await prisma.optionSet.findUnique({
    where: { id: params.id },
    include: {
      fields: {
        orderBy: { sortOrder: "asc" },
        include: { choices: { orderBy: { sortOrder: "asc" } } },
      },
      productMappings: true,
    },
  });

  if (!optionSet || optionSet.shop !== session.shop) {
    throw data("オプションセットが見つかりません。", { status: 404 });
  }

  let productHandles: string[] = [];
  if (optionSet.settingsJson) {
    try {
      const parsed = JSON.parse(optionSet.settingsJson);
      if (typeof parsed.option_set_products === "string") {
        const handles = JSON.parse(parsed.option_set_products);
        if (Array.isArray(handles)) productHandles = handles;
      }
    } catch {
      // settingsJson is best-effort; ignore parse failures.
    }
  }

  const linkedVariantIds = Array.from(
    new Set(
      optionSet.fields.flatMap((f) =>
        f.choices.map((c) => c.linkedVariantId).filter((id): id is string => !!id),
      ),
    ),
  );
  const linkedVariants = await loadLinkedVariants(admin, linkedVariantIds);

  return { optionSet, productHandles, linkedVariants };
};

type ActionData =
  | { ok: true; intent: "publish" | "unpublish"; syncedCount: number }
  | { ok: true; intent: "sync"; syncedCount: number }
  | { ok: true; intent: "linkVariant" }
  | { ok: false; error: string };

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const optionSet = await prisma.optionSet.findUnique({ where: { id: params.id } });
  if (!optionSet || optionSet.shop !== shop) {
    throw data("オプションセットが見つかりません。", { status: 404 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "publish" || intent === "unpublish") {
    await prisma.optionSet.update({
      where: { id: optionSet.id },
      data: { status: intent === "publish" ? "active" : "draft" },
    });
    try {
      const { syncedCount } = await syncOptionSetProducts(admin, shop, optionSet.id);
      return { ok: true, intent, syncedCount } satisfies ActionData;
    } catch (error) {
      if (error instanceof InsufficientScopeError) {
        return { ok: false, error: SCOPE_ERROR_MESSAGE } satisfies ActionData;
      }
      if (error instanceof MetafieldDefinitionError) {
        return { ok: false, error: error.message } satisfies ActionData;
      }
      throw error;
    }
  }

  if (intent === "sync") {
    if (optionSet.status !== "active") {
      return {
        ok: false,
        error: "非公開のセットは同期できません。先に「公開する」を押してください。",
      } satisfies ActionData;
    }
    try {
      const { syncedCount } = await syncOptionSetProducts(admin, shop, optionSet.id);
      return { ok: true, intent: "sync", syncedCount } satisfies ActionData;
    } catch (error) {
      if (error instanceof InsufficientScopeError) {
        return { ok: false, error: SCOPE_ERROR_MESSAGE } satisfies ActionData;
      }
      if (error instanceof MetafieldDefinitionError) {
        return { ok: false, error: error.message } satisfies ActionData;
      }
      throw error;
    }
  }

  if (intent === "linkVariant") {
    const choiceId = String(formData.get("choiceId") ?? "");
    const variantId = String(formData.get("variantId") ?? "").trim();
    const productId = String(formData.get("productId") ?? "").trim();

    const choice = await prisma.optionChoice.findFirst({
      where: { id: choiceId, optionField: { optionSetId: optionSet.id } },
    });
    if (!choice) {
      return { ok: false, error: "選択肢が見つかりません。" } satisfies ActionData;
    }

    await prisma.optionChoice.update({
      where: { id: choiceId },
      data: {
        linkedVariantId: variantId || null,
        linkedProductId: productId || null,
      },
    });

    if (optionSet.status === "active") {
      try {
        await syncOptionSetProducts(admin, shop, optionSet.id);
      } catch (error) {
        if (error instanceof InsufficientScopeError) {
          return { ok: false, error: SCOPE_ERROR_MESSAGE } satisfies ActionData;
        }
        if (error instanceof MetafieldDefinitionError) {
          return { ok: false, error: error.message } satisfies ActionData;
        }
        throw error;
      }
    }

    return { ok: true, intent: "linkVariant" } satisfies ActionData;
  }

  return { ok: false, error: "不明な操作です。" } satisfies ActionData;
};

const STATUS_LABEL: Record<string, string> = {
  active: "公開中",
  draft: "下書き",
  archived: "アーカイブ",
};

const TYPE_LABEL: Record<string, string> = {
  "text-box": "テキスト入力",
  dropdown: "ドロップダウン",
  checkbox: "チェックボックス",
  "product-list": "商品リスト",
  "file-upload": "ファイルアップロード",
};

export default function OptionSetDetail() {
  const { optionSet, productHandles, linkedVariants } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const variantFetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();
  const [pickingChoiceId, setPickingChoiceId] = useState<string | null>(null);
  const isBusy = fetcher.state !== "idle";

  const unsupportedTypes = unsupportedFieldTypes(optionSet.fields);
  const isPublished = optionSet.status === "active";

  const submitIntent = (intent: "publish" | "unpublish" | "sync") => {
    const fd = new FormData();
    fd.set("intent", intent);
    fetcher.submit(fd, { method: "post" });
  };

  const submitLinkVariant = (choiceId: string, variantId: string, productId: string) => {
    const fd = new FormData();
    fd.set("intent", "linkVariant");
    fd.set("choiceId", choiceId);
    fd.set("variantId", variantId);
    fd.set("productId", productId);
    variantFetcher.submit(fd, { method: "post" });
  };

  const openVariantPicker = async (choiceId: string, currentVariantId: string | null) => {
    setPickingChoiceId(choiceId);
    try {
      const selected = await shopify.resourcePicker({
        type: "variant",
        action: "select",
        multiple: false,
        selectionIds: currentVariantId ? [{ id: currentVariantId }] : [],
      });
      if (!selected || selected.length === 0) return; // user cancelled
      const variant = selected[0];
      submitLinkVariant(choiceId, variant.id, variant.product?.id ?? "");
    } finally {
      setPickingChoiceId(null);
    }
  };

  const unlinkVariant = (choiceId: string) => {
    submitLinkVariant(choiceId, "", "");
  };

  return (
    <s-page heading={optionSet.name}>
      <s-link slot="breadcrumb-actions" href="/app/option-sets">
        オプションセット一覧
      </s-link>
      <s-button slot="primary-action" href={`/app/option-sets/${optionSet.id}/products`}>
        商品を紐付け
      </s-button>

      <s-section heading="概要">
        <s-stack direction="inline" gap="large">
          <s-text>
            ステータス:{" "}
            <s-badge tone={isPublished ? "success" : "info"}>
              {STATUS_LABEL[optionSet.status] ?? optionSet.status}
            </s-badge>
          </s-text>
          <s-text>由来: {optionSet.source === "csv" ? "CSV由来" : "手動作成"}</s-text>
          <s-text>項目数: {optionSet.fields.length}</s-text>
          <s-text>
            最終更新: {new Date(optionSet.updatedAt).toLocaleString("ja-JP")}
          </s-text>
        </s-stack>

        <s-stack direction="inline" gap="base">
          {isPublished ? (
            <s-button
              variant="tertiary"
              {...(isBusy ? { loading: true } : {})}
              onClick={() => submitIntent("unpublish")}
            >
              下書きに戻す
            </s-button>
          ) : (
            <s-button
              variant="primary"
              {...(isBusy ? { loading: true } : {})}
              onClick={() => submitIntent("publish")}
            >
              公開する
            </s-button>
          )}
          <s-button
            variant="tertiary"
            {...(isBusy ? { loading: true } : {})}
            onClick={() => submitIntent("sync")}
          >
            メタフィールドを同期
          </s-button>
        </s-stack>

        {fetcher.data?.ok === true && fetcher.data.intent !== "linkVariant" ? (
          <s-banner tone="success" heading="完了しました">
            <s-paragraph>
              {fetcher.data.intent === "publish"
                ? `公開しました。紐付け済み商品 ${fetcher.data.syncedCount}件のメタフィールドを更新しました。`
                : fetcher.data.intent === "unpublish"
                  ? `下書きに戻しました。紐付け済み商品 ${fetcher.data.syncedCount}件のメタフィールドを更新しました。`
                  : `商品 ${fetcher.data.syncedCount}件のメタフィールドを同期しました。`}
            </s-paragraph>
          </s-banner>
        ) : null}
        {fetcher.data?.ok === false ? (
          <s-banner tone="critical" heading="エラー">
            <s-paragraph>{fetcher.data.error}</s-paragraph>
          </s-banner>
        ) : null}
        {variantFetcher.data?.ok === false ? (
          <s-banner tone="critical" heading="追加料金variantの紐付けに失敗しました">
            <s-paragraph>{variantFetcher.data.error}</s-paragraph>
          </s-banner>
        ) : null}

        {unsupportedTypes.length > 0 ? (
          <s-banner tone="warning" heading="商品ページに表示されない項目があります">
            <s-paragraph>
              次のタイプは現在Theme App Extensionが未対応のため、公開してもメタフィールドおよび商品ページには含まれません:{" "}
              {unsupportedTypes.map((t) => TYPE_LABEL[t] ?? t).join(", ")}
            </s-paragraph>
          </s-banner>
        ) : null}

        {productHandles.length > 0 ? (
          <s-paragraph>
            CSV記載の対象商品ハンドル(参考情報): {productHandles.join(", ")}
          </s-paragraph>
        ) : null}
        <s-paragraph>
          紐付け済み商品:{" "}
          {optionSet.productMappings.length === 0
            ? "0件"
            : `${optionSet.productMappings.length}件(有効 ${optionSet.productMappings.filter((m) => m.enabled).length}件)`}
          {" ― "}
          <s-link href={`/app/option-sets/${optionSet.id}/products`}>管理する</s-link>
        </s-paragraph>
      </s-section>

      {optionSet.fields.length === 0 ? (
        <s-section heading="項目">
          <s-paragraph>このセットにはまだ項目がありません。</s-paragraph>
        </s-section>
      ) : (
        optionSet.fields.map((field) => (
          <s-section
            key={field.id}
            heading={`${field.label} (${TYPE_LABEL[field.type] ?? field.type})`}
          >
            <s-stack direction="inline" gap="large">
              <s-text>必須: {field.required ? "はい" : "いいえ"}</s-text>
              {field.placeholder ? (
                <s-text>プレースホルダー: {field.placeholder}</s-text>
              ) : null}
              {field.minLength != null || field.maxLength != null ? (
                <s-text>
                  文字数: {field.minLength ?? 0}〜{field.maxLength ?? "∞"}
                </s-text>
              ) : null}
            </s-stack>
            {field.helpText ? <s-paragraph>{field.helpText}</s-paragraph> : null}

            {field.choices.length > 0 ? (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header>選択肢</s-table-header>
                  <s-table-header format="currency">追加料金</s-table-header>
                  <s-table-header>画像</s-table-header>
                  <s-table-header>追加料金variant</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {field.choices.map((choice) => {
                    const linked = choice.linkedVariantId
                      ? linkedVariants[choice.linkedVariantId]
                      : undefined;
                    const isPickingThis = pickingChoiceId === choice.id;
                    return (
                      <s-table-row key={choice.id}>
                        <s-table-cell>{choice.label}</s-table-cell>
                        <s-table-cell>
                          {choice.priceAdjustment > 0
                            ? `¥${choice.priceAdjustment.toLocaleString("ja-JP")}`
                            : "―"}
                        </s-table-cell>
                        <s-table-cell>
                          {choice.imageUrl ? (
                            <s-thumbnail src={choice.imageUrl} alt={choice.label} size="small" />
                          ) : (
                            "―"
                          )}
                        </s-table-cell>
                        <s-table-cell>
                          <s-stack direction="inline" gap="small-100">
                            {linked ? (
                              <>
                                <s-text>
                                  {linked.productTitle} ― {linked.variantTitle}(¥
                                  {Number(linked.price).toLocaleString("ja-JP")})
                                </s-text>
                                <s-button
                                  variant="tertiary"
                                  {...(isPickingThis ? { loading: true } : {})}
                                  onClick={() => unlinkVariant(choice.id)}
                                >
                                  解除
                                </s-button>
                              </>
                            ) : (
                              <>
                                <s-button
                                  variant="tertiary"
                                  {...(isPickingThis ? { loading: true } : {})}
                                  onClick={() => openVariantPicker(choice.id, null)}
                                >
                                  variantを選択
                                </s-button>
                                {choice.priceAdjustment > 0 ? (
                                  <s-badge tone="warning">追加料金未設定</s-badge>
                                ) : null}
                              </>
                            )}
                          </s-stack>
                        </s-table-cell>
                      </s-table-row>
                    );
                  })}
                </s-table-body>
              </s-table>
            ) : null}
          </s-section>
        ))
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
