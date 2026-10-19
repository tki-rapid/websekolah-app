/** Optional social links on news (Instagram post, Facebook, YouTube). Hosts are allow-listed; embeds load only on user click. */
export function hostOf(u: string): string | null {
  try { const x = new URL(u); if (x.protocol !== "https:") return null; return x.hostname.replace(/^(www|m)\./, ""); } catch { return null; }
}
export function youtubeId(u: string): string {
  try {
    const x = new URL(u); const h = x.hostname.replace(/^(www|m)\./, ""); let id = "";
    if (x.protocol !== "https:") return "";
    if (h === "youtu.be") id = x.pathname.slice(1).split("/")[0] ?? "";
    else if (h === "youtube.com" || h === "youtube-nocookie.com") {
      if (x.pathname === "/watch") id = x.searchParams.get("v") ?? "";
      else { const m = x.pathname.match(/^\/(shorts|embed|live|v)\/([^/?]+)/); id = m?.[2] ?? ""; }
    }
    return /^[A-Za-z0-9_-]{6,15}$/.test(id) ? id : "";
  } catch { return ""; }
}
export function instagramCode(u: string): string {
  try { if (new URL(u).protocol !== "https:") return ""; const m = new URL(u).pathname.match(/^\/(p|reel|tv)\/([A-Za-z0-9_-]+)/); return m ? `${m[1]}/${m[2]}` : ""; } catch { return ""; }
}
