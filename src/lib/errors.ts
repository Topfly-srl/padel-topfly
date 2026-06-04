import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function routeError(error: unknown) {
  if (error instanceof Response) {
    return error;
  }

  if (error instanceof AppError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: error.issues[0]?.message ?? "Dati richiesta non validi." },
      { status: 422 },
    );
  }

  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "JSON richiesta non valido." }, { status: 400 });
  }

  console.error(error);
  return NextResponse.json(
    { error: "Qualcosa e' andato storto. Riprova tra poco." },
    { status: 500 },
  );
}
