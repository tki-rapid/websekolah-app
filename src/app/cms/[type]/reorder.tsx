"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { reorderAction } from "../actions";

export default function ReorderButtons({ type, ids, index }: { type: string; ids: string[]; index: number }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function move(d: number) {
    const j = index + d; if (j < 0 || j >= ids.length) return;
    const next = [...ids]; [next[index], next[j]] = [next[j]!, next[index]!];
    setBusy(true); await reorderAction({ type, ids: next }); setBusy(false); router.refresh();
  }
  return (
    <span className="actions">
      <button className="btn sm" type="button" disabled={busy || index === 0} onClick={() => void move(-1)} aria-label="Naikkan">↑</button>
      <button className="btn sm" type="button" disabled={busy || index === ids.length - 1} onClick={() => void move(1)} aria-label="Turunkan">↓</button>
    </span>
  );
}
