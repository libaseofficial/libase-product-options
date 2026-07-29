import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { data, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  InsufficientScopeError,
  MetafieldDefinitionError,
  syncProducts,
  syncProductMetafield,
} from "../lib/metafield-sync.server";

const SCOPE_ERROR_MESSAGE =
  "Shopifyへのアクセス権限が不足しているため、商品情報を更新できませんでした。管理画面をいったん閉じて開き直し、アプリのアクセス許可を承認し直してください。";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const optionSet = await prisma.optionSet.findUnique({
    where: { id: params.id },
  });
  if (!optionSet || optionSet.shop !== session.shop) {
    throw data("オプションセットが見つかりません。", { status: 404 });
  }

  const productMappings = await prisma.productMapping.findMany({
    where: { optionSetId: optionSet.id },
    orderBy: { createdAt: "asc" },
  });

  return { optionSet, productMappings };
};

interface PickedProduct {
  id: string;
  handle: string;
  title: string;
}

type ActionData =
  | { ok: true; intent: "sync"; created: number; deleted: number; updated: number }
  | { ok: true; intent: "toggle" }
  | { ok: true; intent: "delete" }
  | { ok: false; error: string };

async function loadOwnedOptionSet(shop: string, id: string | undefined) {
  const optionSet = await prisma.optionSet.findUnique({ where: { id } });
  if (!optionSet || optionSet.shop !== shop) {
    throw data("オプションセットが見つかりません。", { status: 404 });
  }
  return optionSet;
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const optionSet = await loadOwnedOptionSet(shop, params.id);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "sync") {
    let products: PickedProduct[];
    try {
      products = JSON.parse(String(formData.get("products") ?? "[]"));
    } catch {
      return { ok: false, error: "選択内容の解析に失敗しました。" } satisfies ActionData;
    }

    const existing = await prisma.productMapping.findMany({
      where: { optionSetId: optionSet.id },
    });
    const existingByProductId = new Map(existing.map((m) => [m.shopifyProductId, m]));
    const desiredIds = new Set(products.map((p) => p.id));

    const toDelete = existing.filter((m) => !desiredIds.has(m.shopifyProductId));
    const toCreate = products.filter((p) => !existingByProductId.has(p.id));
    const toUpdate = products.filter((p) => {
      const current = existingByProductId.get(p.id);
      if (!current) return false;
      return current.productHandle !== p.handle || current.productTitle !== p.title;
    });

    await prisma.$transaction(async (tx) => {
      if (toDelete.length > 0) {
        await tx.productMapping.deleteMany({
          where: { id: { in: toDelete.map((m) => m.id) } },
        });
      }
      if (toCreate.length > 0) {
        await tx.productMapping.createMany({
          data: toCreate.map((p) => ({
            optionSetId: optionSet.id,
            shopifyProductId: p.id,
            productHandle: p.handle,
            productTitle: p.title,
            enabled: true,
          })),
        });
      }
      for (const p of toUpdate) {
        const current = existingByProductId.get(p.id)!;
        await tx.productMapping.update({
          where: { id: current.id },
          data: { productHandle: p.handle, productTitle: p.title },
        });
      }
    });

    if (optionSet.status === "active") {
      const affectedIds = [
        ...toCreate.map((p) => p.id),
        ...toDelete.map((m) => m.shopifyProductId),
      ];
      try {
        await syncProducts(admin, shop, affectedIds);
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

    return {
      ok: true,
      intent: "sync",
      created: toCreate.length,
      deleted: toDelete.length,
      updated: toUpdate.length,
    } satisfies ActionData;
  }

  if (intent === "toggle") {
    const mappingId = String(formData.get("mappingId") ?? "");
    const enabled = formData.get("enabled") === "true";
    const mapping = await prisma.productMapping.findFirst({
      where: { id: mappingId, optionSetId: optionSet.id },
    });
    await prisma.productMapping.updateMany({
      where: { id: mappingId, optionSetId: optionSet.id },
      data: { enabled },
    });
    if (mapping && optionSet.status === "active") {
      try {
        await syncProductMetafield(admin, shop, mapping.shopifyProductId);
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
    return { ok: true, intent: "toggle" } satisfies ActionData;
  }

  if (intent === "delete") {
    const mappingId = String(formData.get("mappingId") ?? "");
    const mapping = await prisma.productMapping.findFirst({
      where: { id: mappingId, optionSetId: optionSet.id },
    });
    await prisma.productMapping.deleteMany({
      where: { id: mappingId, optionSetId: optionSet.id },
    });
    if (mapping && optionSet.status === "active") {
      try {
        await syncProductMetafield(admin, shop, mapping.shopifyProductId);
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
    return { ok: true, intent: "delete" } satisfies ActionData;
  }

  return { ok: false, error: "不明な操作です。" } satisfies ActionData;
};

export default function OptionSetProducts() {
  const { optionSet, productMappings } = useLoaderData<typeof loader>();
  const syncFetcher = useFetcher<ActionData>();
  const rowFetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();
  const [isPicking, setIsPicking] = useState(false);

  const openPicker = async () => {
    setIsPicking(true);
    try {
      const selected = await shopify.resourcePicker({
        type: "product",
        action: "select",
        multiple: true,
        selectionIds: productMappings.map((m) => ({ id: m.shopifyProductId })),
      });
      if (!selected) return; // user cancelled

      const products: PickedProduct[] = selected.map((p) => ({
        id: p.id,
        handle: p.handle,
        title: p.title,
      }));

      const fd = new FormData();
      fd.set("intent", "sync");
      fd.set("products", JSON.stringify(products));
      syncFetcher.submit(fd, { method: "post" });
    } finally {
      setIsPicking(false);
    }
  };

  const toggleMapping = (mappingId: string, enabled: boolean) => {
    const fd = new FormData();
    fd.set("intent", "toggle");
    fd.set("mappingId", mappingId);
    fd.set("enabled", String(enabled));
    rowFetcher.submit(fd, { method: "post" });
  };

  const deleteMapping = (mappingId: string) => {
    const fd = new FormData();
    fd.set("intent", "delete");
    fd.set("mappingId", mappingId);
    rowFetcher.submit(fd, { method: "post" });
  };

  const isSyncing = syncFetcher.state !== "idle" || isPicking;

  return (
    <s-page heading={`商品の紐付け: ${optionSet.name}`}>
      <s-link slot="breadcrumb-actions" href={`/app/option-sets/${optionSet.id}`}>
        セット詳細に戻る
      </s-link>

      <s-section heading="紐付け済み商品">
        <s-paragraph>
          「商品を選択」からShopifyの商品を検索・複数選択して、このオプションセットに紐付けます。選択画面を再度開いて商品のチェックを外すと、その商品の紐付けは解除されます。CSVを再インポートしても、ここでの紐付けは保持されます。
        </s-paragraph>

        <s-button
          variant="primary"
          {...(isSyncing ? { loading: true } : {})}
          onClick={openPicker}
        >
          商品を選択
        </s-button>

        {syncFetcher.data?.ok === true && syncFetcher.data.intent === "sync" ? (
          <s-banner tone="success" heading="紐付けを更新しました">
            <s-paragraph>
              追加 {syncFetcher.data.created}件 / 解除 {syncFetcher.data.deleted}件 / 更新 {syncFetcher.data.updated}件
            </s-paragraph>
          </s-banner>
        ) : null}
        {syncFetcher.data?.ok === false ? (
          <s-banner tone="critical" heading="エラー">
            <s-paragraph>{syncFetcher.data.error}</s-paragraph>
          </s-banner>
        ) : null}

        {productMappings.length === 0 ? (
          <s-paragraph>まだ商品が紐付けられていません。</s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>商品名</s-table-header>
              <s-table-header>ハンドル</s-table-header>
              <s-table-header>有効</s-table-header>
              <s-table-header>操作</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {productMappings.map((mapping) => (
                <s-table-row key={mapping.id}>
                  <s-table-cell>{mapping.productTitle ?? mapping.shopifyProductId}</s-table-cell>
                  <s-table-cell>{mapping.productHandle ?? "―"}</s-table-cell>
                  <s-table-cell>
                    <s-switch
                      checked={mapping.enabled}
                      onChange={(event) =>
                        toggleMapping(mapping.id, event.currentTarget.checked)
                      }
                    ></s-switch>
                  </s-table-cell>
                  <s-table-cell>
                    <s-button variant="tertiary" onClick={() => deleteMapping(mapping.id)}>
                      解除
                    </s-button>
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
