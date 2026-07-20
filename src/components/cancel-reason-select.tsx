"use client";

import {
  cancelReasonOtherLabel,
  cancelReasonPresets,
  maxCancelReasonLength,
  type CancelReasonMode,
} from "@/lib/cancel-reason";

// Piccola select FACOLTATIVA per il motivo di annullamento, condivisa dalla pagina di gestione
// (referente) e dall'area admin cosi' la scelta segue le stesse regole ovunque. Il default e'
// "Nessun motivo": chi non tocca nulla annulla come prima. Scegliendo "Altro" appare un campo di
// testo libero breve. Lo stato (mode + testo) vive nel componente che la usa, cosi' e' azzerabile.
type CancelReasonSelectProps = {
  mode: CancelReasonMode;
  otherText: string;
  onModeChange: (mode: CancelReasonMode) => void;
  onOtherTextChange: (text: string) => void;
  disabled?: boolean;
  idPrefix?: string;
};

export function CancelReasonSelect({
  mode,
  otherText,
  onModeChange,
  onOtherTextChange,
  disabled = false,
  idPrefix = "cancel-reason",
}: CancelReasonSelectProps) {
  return (
    <div className="cancel-reason">
      <label className="stack-label">
        Motivo annullamento (facoltativo)
        <select
          id={`${idPrefix}-select`}
          value={mode}
          disabled={disabled}
          onChange={(event) => onModeChange(event.target.value as CancelReasonMode)}
        >
          <option value="">Nessun motivo</option>
          {cancelReasonPresets.map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
          <option value="OTHER">{cancelReasonOtherLabel}</option>
        </select>
      </label>
      {mode === "OTHER" ? (
        <label className="stack-label">
          Specifica il motivo
          <input
            id={`${idPrefix}-text`}
            value={otherText}
            disabled={disabled}
            maxLength={maxCancelReasonLength}
            placeholder="Motivo breve"
            onChange={(event) => onOtherTextChange(event.target.value)}
          />
        </label>
      ) : null}
    </div>
  );
}
