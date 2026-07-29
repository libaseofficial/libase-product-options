import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { isSupportedFieldType, type SupportedFieldType } from "./option-field-types";

/**
 * OptionSet / OptionField / OptionChoice を商品メタフィールドへ同期する。
 *
 * 同期対象: status が "active"(公開)のOptionSetに、enabled な ProductMapping で
 * 紐付いている商品のみ。metafield は namespace=libase_options / key=configuration / type=json。
 *
 * Theme App Extensionが未対応のフィールドタイプ(product-list, file-upload)は
 * メタフィールドJSONから除外する。除外の有無は unsupportedFieldTypes() で検出でき、
 * 管理画面の警告表示に使う。
 */

export const METAFIELD_NAMESPACE = "libase_options";
export const METAFIELD_KEY = "configuration";

/**
 * アクセストークンのスコープ不足でAdmin APIが拒否したことを表すエラー。
 * ルートのaction側で捕捉し、生のGraphQLエラーの代わりに
 * 日本語で再認可を促すメッセージを表示するために使う。
 */
export class InsufficientScopeError extends Error {
  constructor() {
    super("Insufficient access scope for Admin API request.");
    this.name = "InsufficientScopeError";
  }
}

function isAccessDeniedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const body = (error as { body?: unknown }).body;
  if (!body || typeof body !== "object") return false;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      (e as { extensions?: { code?: string } }).extensions?.code === "ACCESS_DENIED",
  );
}

async function adminGraphql(
  admin: AdminApiContext,
  query: string,
  options?: Parameters<AdminApiContext["graphql"]>[1],
): ReturnType<AdminApiContext["graphql"]> {
  try {
    return await admin.graphql(query, options);
  } catch (error) {
    if (isAccessDeniedError(error)) {
      throw new InsufficientScopeError();
    }
    throw error;
  }
}

/**
 * MetafieldDefinitionCreate の userErrors を日本語メッセージへ変換する。
 * 未知のcodeはメッセージをそのまま添えた汎用文言にフォールバックする。
 */
const DEFINITION_ERROR_MESSAGES: Record<string, string> = {
  RESERVED_NAMESPACE_KEY: "namespace/keyがShopifyの予約語と重複しています。",
  LIMIT_EXCEEDED: "メタフィールド定義の作成上限に達しています。",
  RESOURCE_TYPE_LIMIT_EXCEEDED: "対象リソースのメタフィールド定義数が上限に達しています。",
  RESOURCE_TYPE_LIMIT_EXCEEDED_BY_APP: "このアプリが作成できるメタフィールド定義数の上限に達しています。",
  INVALID: "入力内容が不正です。",
  INVALID_CHARACTER: "namespace/keyに使用できない文字が含まれています。",
  INVALID_OPTION: "指定したオプションが不正です。",
  TOO_LONG: "入力値が長すぎます。",
  TOO_SHORT: "入力値が短すぎます。",
  BLANK: "必須項目が空です。",
  PRESENT: "入力してはいけない項目に値が入っています。",
};

function translateDefinitionUserError(code: string | null | undefined, message: string): string {
  const known = code ? DEFINITION_ERROR_MESSAGES[code] : undefined;
  return known ? `${known}(${message})` : `メタフィールド定義の作成に失敗しました: ${message}`;
}

/**
 * MetafieldDefinitionCreate が定義の重複作成以外の理由で失敗したことを表すエラー。
 * message には日本語化済みの説明文が入る。
 */
export class MetafieldDefinitionError extends Error {
  constructor(reasons: string[]) {
    super(reasons.join("\n"));
    this.name = "MetafieldDefinitionError";
  }
}

interface MetafieldDefinitionUserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

// プロセス起動中に一度確認できれば十分なため、確認済みshopをメモリ上にキャッシュする。
const definitionEnsuredShops = new Set<string>();

/**
 * libase_options.configuration の MetafieldDefinition(ownerType=PRODUCT)が
 * 存在することを保証する。無ければ作成し、既にあれば何もしない。
 * 初回同期前(プロセス起動後で最初にこのshopへ同期する直前)に一度だけAPIを呼ぶ。
 */
export async function ensureMetafieldDefinition(
  admin: AdminApiContext,
  shop: string,
): Promise<void> {
  if (definitionEnsuredShops.has(shop)) return;

  const existingResponse = await adminGraphql(
    admin,
    `#graphql
    query LibaseFindMetafieldDefinition($namespace: String!, $key: String!) {
      metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: $namespace, key: $key) {
        nodes { id }
      }
    }`,
    { variables: { namespace: METAFIELD_NAMESPACE, key: METAFIELD_KEY } },
  );
  const existingJson = await existingResponse.json();
  if ((existingJson.data?.metafieldDefinitions?.nodes?.length ?? 0) > 0) {
    definitionEnsuredShops.add(shop);
    return;
  }

  const createResponse = await adminGraphql(
    admin,
    `#graphql
    mutation LibaseCreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id }
        userErrors { field message code }
      }
    }`,
    {
      variables: {
        definition: {
          name: "LIBASE Product Options",
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          type: "json",
          ownerType: "PRODUCT",
        },
      },
    },
  );
  const createJson = await createResponse.json();
  const userErrors: MetafieldDefinitionUserError[] =
    createJson.data?.metafieldDefinitionCreate?.userErrors ?? [];

  // TAKEN = 他プロセスとの競合などで既に作成済み。エラー扱いしない。
  const realErrors = userErrors.filter((e) => e.code !== "TAKEN");
  if (realErrors.length > 0) {
    throw new MetafieldDefinitionError(
      realErrors.map((e) => translateDefinitionUserError(e.code, e.message)),
    );
  }

  definitionEnsuredShops.add(shop);
}

export interface ConfigChoice {
  id: string;
  label: string;
  value: string;
  imageUrl: string | null;
  priceAdjustment: number;
  linkedVariantId: string | null;
}

export interface ConfigField {
  id: string;
  type: SupportedFieldType;
  label: string;
  required: boolean;
  placeholder: string | null;
  helpText: string | null;
  maxLength: number | null;
  choices?: ConfigChoice[];
}

export interface ConfigOptionSet {
  id: string;
  name: string;
  fields: ConfigField[];
}

export interface ProductConfiguration {
  version: 1;
  optionSets: ConfigOptionSet[];
}

async function loadOptionSetConfig(
  optionSetId: string,
): Promise<ConfigOptionSet | null> {
  const optionSet = await prisma.optionSet.findUnique({
    where: { id: optionSetId },
    include: {
      fields: {
        orderBy: { sortOrder: "asc" },
        include: { choices: { orderBy: { sortOrder: "asc" } } },
      },
    },
  });
  if (!optionSet) return null;

  const fields: ConfigField[] = optionSet.fields
    .filter((f) => isSupportedFieldType(f.type))
    .map((f) => ({
      id: f.id,
      type: f.type as SupportedFieldType,
      label: f.label,
      required: f.required,
      placeholder: f.placeholder,
      helpText: f.helpText,
      maxLength: f.maxLength,
      ...(f.type === "text-box"
        ? {}
        : {
            choices: f.choices.map((c) => ({
              id: c.id,
              label: c.label,
              value: c.value,
              imageUrl: c.imageUrl,
              priceAdjustment: c.priceAdjustment,
              linkedVariantId: c.linkedVariantId,
            })),
          }),
    }));

  return { id: optionSet.id, name: optionSet.name, fields };
}

async function buildProductConfiguration(
  shop: string,
  shopifyProductId: string,
): Promise<ProductConfiguration | null> {
  const mappings = await prisma.productMapping.findMany({
    where: {
      shopifyProductId,
      enabled: true,
      optionSet: { shop, status: "active" },
    },
    select: { optionSetId: true },
  });
  if (mappings.length === 0) return null;

  const optionSets: ConfigOptionSet[] = [];
  for (const mapping of mappings) {
    const config = await loadOptionSetConfig(mapping.optionSetId);
    if (config && config.fields.length > 0) {
      optionSets.push(config);
    }
  }

  if (optionSets.length === 0) return null;
  return { version: 1, optionSets };
}

async function getExistingMetafieldId(
  admin: AdminApiContext,
  shopifyProductId: string,
): Promise<string | null> {
  const response = await adminGraphql(
    admin,
    `#graphql
    query LibaseGetProductMetafield($id: ID!, $namespace: String!, $key: String!) {
      product(id: $id) {
        metafield(namespace: $namespace, key: $key) {
          id
        }
      }
    }`,
    {
      variables: {
        id: shopifyProductId,
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
      },
    },
  );
  const json = await response.json();
  return json.data?.product?.metafield?.id ?? null;
}

/**
 * 商品1件分のメタフィールドを、現在のDB状態(公開状態・紐付け)に合わせて更新する。
 * 同期対象のOptionSetが存在しなければメタフィールドを削除する。
 */
export async function syncProductMetafield(
  admin: AdminApiContext,
  shop: string,
  shopifyProductId: string,
): Promise<void> {
  const config = await buildProductConfiguration(shop, shopifyProductId);

  if (!config) {
    const existingId = await getExistingMetafieldId(admin, shopifyProductId);
    if (existingId) {
      await adminGraphql(
        admin,
        `#graphql
        mutation LibaseDeleteProductMetafield($input: MetafieldDeleteInput!) {
          metafieldDelete(input: $input) {
            deletedId
            userErrors { field message }
          }
        }`,
        { variables: { input: { id: existingId } } },
      );
    }
    return;
  }

  await ensureMetafieldDefinition(admin, shop);

  await adminGraphql(
    admin,
    `#graphql
    mutation LibaseSetProductMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopifyProductId,
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(config),
          },
        ],
      },
    },
  );
}

export async function syncProducts(
  admin: AdminApiContext,
  shop: string,
  shopifyProductIds: string[],
): Promise<void> {
  const unique = Array.from(new Set(shopifyProductIds));
  for (const shopifyProductId of unique) {
    await syncProductMetafield(admin, shop, shopifyProductId);
  }
}

/**
 * OptionSetに紐付く(enabledな)商品すべてを再同期する。
 * 公開/下書き切替時や、管理画面の「同期」ボタン押下時に使う。
 */
export async function syncOptionSetProducts(
  admin: AdminApiContext,
  shop: string,
  optionSetId: string,
): Promise<{ syncedCount: number }> {
  const mappings = await prisma.productMapping.findMany({
    where: { optionSetId, enabled: true },
    select: { shopifyProductId: true },
  });
  await syncProducts(
    admin,
    shop,
    mappings.map((m) => m.shopifyProductId),
  );
  return { syncedCount: mappings.length };
}
