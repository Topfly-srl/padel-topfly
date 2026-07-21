"use client";

import { Lock, Trash2 } from "lucide-react";
import { useState } from "react";
import { appPath } from "@/lib/app-path";
import {
  dateTimeFromParts,
  localTime,
  networkErrorText,
  pad,
  readApiError,
  type Notice,
} from "@/lib/booking-ui";
import type { AvailabilityBlock } from "@/lib/types";

export function AdminBlocksSection({
  options,
  selectedDate,
  dayBlocks,
  onRefresh,
  setNotice,
}: {
  options: string[];
  selectedDate: string;
  dayBlocks: AvailabilityBlock[];
  onRefresh: () => Promise<void>;
  setNotice: (notice: Notice) => void;
}) {
  const [blockStart, setBlockStart] = useState("09:00");
  const [blockEnd, setBlockEnd] = useState("10:00");
  const [blockReason, setBlockReason] = useState("Manutenzione");

  // Le option in ingresso sono gli INIZI slot (…, 23:45): come fine blocco serve lo stesso passo
  // spostato di uno slot, altrimenti l'ultimo quarto d'ora (23:45-24:00) resterebbe imbloccabile.
  // "24:00" e' ora ISO valida: dateTimeFromParts la converte nella mezzanotte del giorno dopo.
  const endOptions = options.map((option) => {
    const [hours, minutes] = option.split(":").map(Number);
    const total = hours * 60 + minutes + 15;
    return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
  });

  async function createBlock() {
    try {
      const response = await fetch(appPath("/api/admin/blocks"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: dateTimeFromParts(selectedDate, blockStart).toISOString(),
          end: dateTimeFromParts(selectedDate, blockEnd).toISOString(),
          reason: blockReason,
        }),
      });

      if (!response.ok) {
        setNotice({ type: "error", text: await readApiError(response) });
        return;
      }

      setNotice({ type: "success", text: "Blocco admin creato." });
      await onRefresh();
    } catch {
      setNotice({ type: "error", text: networkErrorText });
    }
  }

  async function deleteBlock(id: string) {
    if (!window.confirm("Vuoi rimuovere questo blocco admin?")) {
      return;
    }

    try {
      const response = await fetch(appPath(`/api/admin/blocks/${id}`), { method: "DELETE" });

      if (!response.ok) {
        setNotice({ type: "error", text: await readApiError(response) });
        return;
      }

      setNotice({ type: "info", text: "Blocco rimosso." });
      await onRefresh();
    } catch {
      setNotice({ type: "error", text: networkErrorText });
    }
  }

  return (
    <details>
      <summary>Blocchi admin</summary>
      <div className="selector-row compact">
        <label>
          Da
          <select value={blockStart} onChange={(event) => setBlockStart(event.target.value)}>
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          A
          <select value={blockEnd} onChange={(event) => setBlockEnd(event.target.value)}>
            {endOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="stack-label">
        Motivo
        <input
          value={blockReason}
          onChange={(event) => setBlockReason(event.target.value)}
        />
      </label>
      <button className="ghost-button full-width" onClick={createBlock} type="button">
        <Lock size={16} />
        Blocca fascia
      </button>

      {dayBlocks.length ? (
        <div className="booking-list">
          {dayBlocks.map((block) => (
            <article className="booking-item blocked-item" key={block.id}>
              <div>
                <strong>
                  {localTime(new Date(block.start))} - {localTime(new Date(block.end))}
                </strong>
                <span>{block.reason}</span>
              </div>
              <button
                className="mini-button danger"
                onClick={() => deleteBlock(block.id)}
                type="button"
                aria-label="Rimuovi blocco"
                title="Rimuovi blocco"
              >
                <Trash2 size={15} />
              </button>
            </article>
          ))}
        </div>
      ) : null}
    </details>
  );
}
