/**
 * Safe rich text (PRD §7: "Rich text hanya mengizinkan elemen aman; tidak ada JavaScript, iframe atau HTML mentah").
 * Authors write a tiny Markdown subset; the server REJECTS raw HTML on write and ESCAPES everything on render, so
 * there is no sanitiser to bypass: **bold**, *italic*, "- " lists, [text](https://link), blank line = paragraph.
 */
const RAW_HTML = /<\/?[a-z!][^>]*>|javascript:|data:text\/html|on[a-z]+\s*=/i;
export const hasRawHtml = (s: string) => RAW_HTML.test(s);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const inline = (s: string) =>
  s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

export function richToHtml(text: string): string {
  const lines = esc(text ?? "").split("\n");
  let out = "", list = false, para: string[] = [];
  const flush = () => { if (para.length) { out += `<p>${inline(para.join("<br>"))}</p>`; para = []; } };
  for (const l of lines) {
    if (/^\s*[-*] /.test(l)) { flush(); if (!list) { out += "<ul>"; list = true; } out += `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`; }
    else { if (list) { out += "</ul>"; list = false; } if (!l.trim()) flush(); else para.push(l); }
  }
  flush(); if (list) out += "</ul>";
  return out;
}
export const slugify = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
