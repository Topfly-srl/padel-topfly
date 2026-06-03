import { NextResponse } from "next/server";

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

  console.error(error);
  return NextResponse.json(
    { error: "Qualcosa e' andato storto. Riprova tra poco." },
    { status: 500 },
  );
}
