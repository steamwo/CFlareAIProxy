export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly type = "gateway_error",
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function normalizeGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;

  const message = errorMessage(error);
  if (/\bno such table\b/i.test(message)) {
    return new GatewayError(
      503,
      "DATABASE_NOT_INITIALIZED",
      "The remote D1 database schema is not initialized. Apply the remote migrations and redeploy.",
      "configuration_error",
    );
  }
  if (
    /Cannot read properties of (?:undefined|null).*\bprepare\b/i.test(message)
    || /\bD1\b.*\bbinding\b.*(?:missing|not found|undefined)/i.test(message)
  ) {
    return new GatewayError(
      503,
      "DATABASE_BINDING_MISSING",
      "The D1 database binding is unavailable. Verify that the Worker has a DB binding and redeploy.",
      "configuration_error",
    );
  }

  return new GatewayError(500, "INTERNAL_ERROR", "Internal gateway error", "internal_error");
}

export function errorResponse(error: unknown, requestId?: string): Response {
  const normalized = normalizeGatewayError(error);

  if (!(error instanceof GatewayError)) {
    console.error(JSON.stringify({
      event: "unhandled_gateway_error",
      request_id: requestId,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
      normalized_code: normalized.code,
    }));
  }

  return Response.json(
    {
      error: {
        message: normalized.message,
        type: normalized.type,
        code: normalized.code,
        request_id: requestId,
      },
    },
    {
      status: normalized.status,
      headers: {
        "cache-control": "no-store",
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
    },
  );
}
