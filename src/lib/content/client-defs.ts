import { typeDef, type FieldDef, type TypeDef } from "@/lib/content/types";

/** Function-free copy of a type definition that can cross the server → client boundary. */
export type ClientDef = Pick<TypeDef, "type" | "label" | "one" | "route" | "titleField" | "slug" | "ordered" | "singleton" | "note"> & { fields: FieldDef[]; defaults: Record<string, unknown> };
export function clientDef(type: string): ClientDef | null {
  const d = typeDef(type); if (!d) return null;
  const { type: t, label, one, route, titleField, slug, ordered, singleton, note, fields } = d;
  return { type: t, label, one, route, titleField, slug, ordered, singleton, note, fields, defaults: d.defaults?.() ?? {} };
}
