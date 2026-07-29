/**
 * Theme App Extensionが対応している/していないオプションタイプの定義。
 * クライアント(管理画面のUI)とサーバー(メタフィールド同期)の両方から参照するため、
 * `.server.ts` には置かない。
 */
export const SUPPORTED_FIELD_TYPES = ["text-box", "dropdown", "checkbox"] as const;
export type SupportedFieldType = (typeof SUPPORTED_FIELD_TYPES)[number];

export function isSupportedFieldType(type: string): type is SupportedFieldType {
  return (SUPPORTED_FIELD_TYPES as readonly string[]).includes(type);
}

export function unsupportedFieldTypes(fields: { type: string }[]): string[] {
  const found = new Set<string>();
  for (const f of fields) {
    if (!isSupportedFieldType(f.type)) {
      found.add(f.type);
    }
  }
  return Array.from(found);
}
