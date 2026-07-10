import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export interface ApiError extends Error {
  statusCode?: number;
}

/**
 * Emits the standard's ErrorResponse shape: { error: { code, message, details } }.
 */
export function errorHandler(
  err: ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "validation_error",
        message: "Request does not conform to the Open CDR Standard",
        details: err.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      },
    });
    return;
  }

  const status = err.statusCode ?? 500;
  const message = err.message ?? "Internal server error";

  if (status >= 500) console.error("Server error:", err);

  res.status(status).json({
    error: {
      code: httpStatusToCode(status),
      message,
    },
  });
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({
    error: { code: "not_found", message: "Route not found" },
  });
}

export function createError(message: string, statusCode: number): ApiError {
  const err: ApiError = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function httpStatusToCode(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    default:
      return "internal_error";
  }
}
