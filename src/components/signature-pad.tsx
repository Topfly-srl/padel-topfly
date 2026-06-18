"use client";

import { RotateCcw } from "lucide-react";
import type { PointerEvent } from "react";
import { useCallback, useEffect, useRef } from "react";

type SignaturePadProps = {
  value: string;
  showError?: boolean;
  onChange: (value: string) => void;
  onTouched?: () => void;
};

function drawGuide(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(18, height - 32);
  ctx.lineTo(width - 18, height - 32);
  ctx.stroke();
}

export function SignaturePad({ value, showError = false, onChange, onTouched }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const hasSignature = Boolean(value);

  const resetCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return false;

    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;

    ctx.scale(ratio, ratio);
    drawGuide(ctx, rect.width, rect.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2.6;
    return true;
  }, []);

  useEffect(() => {
    resetCanvas();
  }, [resetCanvas]);

  useEffect(() => {
    if (!value) resetCanvas();
  }, [resetCanvas, value]);

  const pointFromEvent = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const saveSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onChange(canvas.toDataURL("image/png"));
  };

  const startDrawing = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const point = pointFromEvent(event);
    if (!canvas || !point) return;

    onTouched?.();
    canvas.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    lastPointRef.current = point;
    event.preventDefault();
  };

  const draw = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const point = pointFromEvent(event);
    const previous = lastPointRef.current;
    if (!canvas || !point || !previous) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.beginPath();
    ctx.moveTo(previous.x, previous.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPointRef.current = point;
    event.preventDefault();
  };

  const stopDrawing = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastPointRef.current = null;
    saveSignature();
    event.preventDefault();
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    resetCanvas();
    onTouched?.();
    onChange("");
  };

  return (
    <div className="signature-pad-field">
      <div className="signature-pad-head">
        <div>
          <strong>Firma col dito</strong>
          <small>Firma elettronica semplice acquisita tramite web app.</small>
        </div>
        <button className="ghost-button compact" onClick={clearSignature} type="button">
          <RotateCcw size={15} />
          Cancella
        </button>
      </div>
      <canvas
        ref={canvasRef}
        aria-invalid={showError || undefined}
        aria-label="Disegna la tua firma"
        className="signature-pad"
        onPointerCancel={stopDrawing}
        onPointerDown={startDrawing}
        onPointerLeave={stopDrawing}
        onPointerMove={draw}
        onPointerUp={stopDrawing}
      />
      {showError ? (
        <small className="field-hint error">Disegna la firma nel riquadro per continuare.</small>
      ) : (
        <small className={`field-hint ${hasSignature ? "success" : ""}`}>
          {hasSignature ? "Firma acquisita." : "Usa il mouse o il polpastrello nel riquadro."}
        </small>
      )}
    </div>
  );
}
