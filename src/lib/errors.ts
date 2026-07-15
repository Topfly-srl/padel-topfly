import { NextResponse } from "next/server";
import { ZodError } from "zod";

export const noStoreHeaders = {
  "Cache-Control": "no-store, max-age=0",
};

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);

  for (const [key, value] of Object.entries(noStoreHeaders)) {
    headers.set(key, value);
  }

  return NextResponse.json(body, {
    ...init,
    headers,
  });
}

export function routeError(error: unknown) {
  if (error instanceof Response) {
    const headers = new Headers(error.headers);

    for (const [key, value] of Object.entries(noStoreHeaders)) {
      headers.set(key, value);
    }

    return new Response(error.body, {
      status: error.status,
      statusText: error.statusText,
      headers,
    });
  }

  if (error instanceof AppError) {
    return jsonResponse({ error: error.message }, { status: error.status });
  }

  if (error instanceof ZodError) {
    return jsonResponse(
      { error: error.issues[0]?.message ?? "Dati richiesta non validi." },
      { status: 422 },
    );
  }

  if (error instanceof SyntaxError) {
    return jsonResponse({ error: "JSON richiesta non valido." }, { status: 400 });
  }

  if (error instanceof Error) {
    console.error({ name: error.name, message: error.message });
  } else {
    console.error({ message: "Unknown route error" });
  }
  return jsonResponse(
    { error: "Qualcosa è andato storto. Riprova tra poco." },
    { status: 500 },
  );
}
