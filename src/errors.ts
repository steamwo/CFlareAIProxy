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

export function errorResponse(error: unknown, requestId?: string): Response {
  const normalized =
    error instanceof GatewayError
      ? error
      : new GatewayError(500, "INTERNAL_ERROR", "Internal gateway error", "internal_error");

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
