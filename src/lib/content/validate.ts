import { hasRawHtml } from "@/lib/richtext";
import { hostOf } from "@/lib/content/social";
import { type FieldDef, type TypeDef } from "@/lib/content/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type Errors = Record<string, string>;
export type Validated = { clean: Record<string, unknown>; errors: Errors; mediaIds: string[] };

const isStr = (v: unknown): v is string => typeof v === "string";

function checkScalar(f: FieldDef, raw: unknown, path: string, errs: Errors, media: string[], relaxed: boolean): unknown {
  const empty = raw === undefined || raw === null || raw === "";
  if (f.kind === "checkbox") return raw === true || raw === "true" || raw === "on";
  if (empty) { if (f.required && !relaxed) errs[path] = `${f.label} wajib diisi`; return ""; }
  if (!isStr(raw)) { errs[path] = `${f.label} tidak valid`; return ""; }
  const s = raw.trim();
  if (f.max && s.length > f.max) { errs[path] = `${f.label} maksimal ${f.max} karakter (sekarang ${s.length})`; return s; }
  if ((f.kind === "text" || f.kind === "textarea" || f.kind === "richtext") && hasRawHtml(s)) { errs[path] = "HTML mentah / JavaScript tidak diizinkan"; return s; }
  switch (f.kind) {
    case "select": if (!f.options?.some(([v]) => v === s)) errs[path] = "Nilai tidak dikenal"; break;
    case "date": if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) errs[path] = "Tanggal tidak valid"; break;
    case "datetime": if (Number.isNaN(Date.parse(s))) errs[path] = "Waktu tidak valid"; else return new Date(s).toISOString(); break;
    case "year": { const y = Number(s); if (!/^\d{4}$/.test(s) || y < 1900 || y > new Date().getFullYear() + 1) errs[path] = `Tahun harus 4 digit (1900–${new Date().getFullYear() + 1})`; break; }
    case "email": if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) errs[path] = "Format email tidak valid"; break;
    case "tel": if (!/^[0-9+()\-\s]{6,20}$/.test(s)) errs[path] = "Format telepon tidak valid"; break;
    case "url": {
      const h = hostOf(s);
      if (!h) errs[path] = "URL harus diawali https:// dan valid";
      else if (f.hosts && !f.hosts.includes(h)) errs[path] = f.msg ?? "Tautan harus berasal dari domain resmi platform ini";
      else if (f.pathRe && !new RegExp(f.pathRe).test(new URL(s).pathname)) errs[path] = f.msg ?? "Format tautan tidak valid";
      break;
    }
    case "media": if (!UUID.test(s)) errs[path] = "Media tidak valid"; else media.push(s); break;
  }
  return s;
}

/**
 * Validate and normalise a payload against its definition. `relaxed` (draft saves) only enforces the title field,
 * so authors can save work in progress; publishing runs the full rules. Unknown keys are discarded.
 */
export function validatePayload(def: TypeDef, input: unknown, o: { relaxed?: boolean } = {}): Validated {
  const errors: Errors = {}; const mediaIds: string[] = []; const clean: Record<string, unknown> = {};
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const f of def.fields) {
    const relaxed = !!o.relaxed && f.name !== def.titleField;
    if (f.kind === "repeater") {
      const rows = Array.isArray(src[f.name]) ? (src[f.name] as unknown[]) : [];
      if (rows.length > 100) { errors[f.name] = "Terlalu banyak baris (maks. 100)"; continue; }
      if (f.required && !rows.length && !relaxed) errors[f.name] = `${f.label} wajib minimal 1 baris`;
      clean[f.name] = rows.map((r, i) => {
        const row = (r && typeof r === "object" ? r : {}) as Record<string, unknown>; const out: Record<string, unknown> = {};
        for (const sf of f.sub ?? []) out[sf.name] = checkScalar(sf, row[sf.name], `${f.name}.${i}.${sf.name}`, errors, mediaIds, relaxed);
        return out;
      });
    } else clean[f.name] = checkScalar(f, src[f.name], f.name, errors, mediaIds, relaxed);
  }
  def.extra?.(clean, errors);
  // ── English translation (_en): only translatable fields, strings only, same length/HTML rules, never required ──
  const en = src._en && typeof src._en === "object" ? (src._en as Record<string, unknown>) : null;
  if (en) {
    const cleanEn: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (f.kind === "repeater") {
        const rows = en[f.name]; if (!Array.isArray(rows)) continue;
        const base = (clean[f.name] as unknown[]) ?? [];
        const out = base.map((_, i) => {
          const r = (rows[i] && typeof rows[i] === "object" ? rows[i] : {}) as Record<string, unknown>; const o2: Record<string, unknown> = {};
          for (const sf of (f.sub ?? []).filter((x) => x.tr)) { const v = checkScalar({ ...sf, required: false }, r[sf.name], `_en.${f.name}.${i}.${sf.name}`, errors, [], true); if (v) o2[sf.name] = v; }
          return o2;
        });
        if (out.some((r) => Object.keys(r).length)) cleanEn[f.name] = out;
      } else if (f.tr) {
        const v = checkScalar({ ...f, required: false }, en[f.name], `_en.${f.name}`, errors, [], true); if (v) cleanEn[f.name] = v;
      }
    }
    if (Object.keys(cleanEn).length) clean._en = cleanEn;
  }
  return { clean, errors, mediaIds: [...new Set(mediaIds)] };
}

/** none | partial | complete — English translation coverage of a payload. */
export function translationState(def: TypeDef, payload: Record<string, unknown> | null): "none" | "partial" | "complete" {
  const en = payload?._en as Record<string, unknown> | undefined;
  if (!en || !Object.keys(en).length) return "none";
  const req = def.fields.filter((f) => f.tr && f.required).map((f) => f.name);
  if (!req.length) return "complete";
  return req.every((k) => !!en[k]) ? "complete" : "partial";
}
