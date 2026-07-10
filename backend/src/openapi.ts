import fs from "fs";
import yaml from "js-yaml";
import { config } from "./config";

/**
 * Load the Open CDR Standard schema verbatim and augment it with the one path
 * this platform adds beyond the read-only standard: POST /calls/ingest. The
 * augmented document is what Swagger UI renders, so the docs stay a faithful
 * copy of the standard plus a clearly-labelled platform extension.
 */
function loadSpec(): Record<string, any> {
  const raw = fs.readFileSync(config.paths.schemaYaml, "utf-8");
  const spec = yaml.load(raw) as Record<string, any>;

  spec.paths = spec.paths ?? {};
  spec.paths["/calls/ingest"] = {
    post: {
      operationId: "ingestCallRecords",
      summary: "Ingest one or more Call Detail Records (platform extension)",
      description:
        "Accepts a single CallRecord or an array of CallRecords. Each is " +
        "validated against the standard and upserted by callId. This endpoint " +
        "is not part of the read-only Open CDR Standard; it is how this " +
        "reference platform receives records from a switch or connector.",
      tags: ["Ingest"],
      security: [{ ApiKeyAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              oneOf: [
                { $ref: "#/components/schemas/CallRecord" },
                {
                  type: "array",
                  items: { $ref: "#/components/schemas/CallRecord" },
                },
              ],
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Records accepted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  accepted: { type: "integer" },
                  created: { type: "integer" },
                  updated: { type: "integer" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  };

  const windowParams = [
    { name: "startTime", in: "query", required: true, schema: { type: "string", format: "date-time" } },
    { name: "endTime", in: "query", required: true, schema: { type: "string", format: "date-time" } },
    { name: "mediaType", in: "query", required: false, schema: { type: "string" }, description: "Comma-delimited" },
    { name: "groups", in: "query", required: false, schema: { type: "string" }, description: "Comma-delimited" },
    { name: "excludeGroups", in: "query", required: false, schema: { type: "string" }, description: "Comma-delimited" },
    { name: "sourcePlatformId", in: "query", required: false, schema: { type: "string" }, description: "Comma-delimited" },
    { name: "X-Tenant-Id", in: "header", required: false, schema: { type: "string" } },
  ];

  spec.paths["/statistics/top-talkers"] = {
    get: {
      operationId: "getTopTalkers",
      summary: "Participants ranked by call count (platform extension)",
      description:
        "Ranks participants (excluding system-component roles like ivr/queue) by " +
        "call count and total call duration over the given window. Not part of " +
        "the standard's documented API.",
      tags: ["Insights"],
      parameters: [
        ...windowParams,
        { name: "limit", in: "query", required: false, schema: { type: "integer", default: 10, maximum: 50 } },
        {
          name: "scope",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["internal", "external", "all"], default: "all" },
          description:
            "internal = participant carried a userId on at least one call; " +
            "external = every appearance was extension-only.",
        },
      ],
      responses: {
        "200": {
          description: "Ranked participants",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        identity: { type: "string" },
                        displayName: { type: "string", nullable: true },
                        isInternal: { type: "boolean" },
                        callCount: { type: "integer" },
                        totalDurationSeconds: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
      },
    },
  };

  spec.paths["/statistics/throughput"] = {
    get: {
      operationId: "getThroughput",
      summary: "Call volume bucketed over time (platform extension)",
      description:
        "Call counts grouped into hourly or daily buckets over the given window. " +
        "Not part of the standard's documented API.",
      tags: ["Insights"],
      parameters: [
        ...windowParams,
        { name: "bucket", in: "query", required: false, schema: { type: "string", enum: ["hour", "day"], default: "day" } },
      ],
      responses: {
        "200": {
          description: "Time-bucketed call counts",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        bucketStart: { type: "string", format: "date-time" },
                        count: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
      },
    },
  };

  spec.paths["/statistics/throughput/by-outcome"] = {
    get: {
      operationId: "getThroughputByOutcome",
      summary: "Call volume bucketed over time, split answered/unanswered (platform extension)",
      description:
        "Same buckets as GET /statistics/throughput, split into answered " +
        "(callState 'ended') and unanswered (callState 'missed' or 'abandoned'). " +
        "Ongoing calls count toward neither. Not part of the standard's documented API.",
      tags: ["Insights"],
      parameters: [
        ...windowParams,
        { name: "bucket", in: "query", required: false, schema: { type: "string", enum: ["hour", "day"], default: "day" } },
      ],
      responses: {
        "200": {
          description: "Time-bucketed answered/unanswered call counts",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        bucketStart: { type: "string", format: "date-time" },
                        answered: { type: "integer" },
                        unanswered: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
      },
    },
  };

  spec.paths["/statistics/by-platform"] = {
    get: {
      operationId: "getPlatformBreakdown",
      summary: "Call counts by source platform (platform extension)",
      description:
        "Call counts grouped by sourcePlatformId over the given window. Records " +
        "without one group under a null bucket. Not part of the standard's " +
        "documented API.",
      tags: ["Insights"],
      parameters: windowParams,
      responses: {
        "200": {
          description: "Call counts by source platform",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        sourcePlatformId: { type: "string", nullable: true },
                        count: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
      },
    },
  };

  const bucketParam = {
    name: "bucket",
    in: "query",
    required: false,
    schema: { type: "string", enum: ["hour", "day"], default: "day" },
  };
  const limitParam = {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", default: 10, maximum: 50 },
  };

  spec.paths["/statistics/handle-time"] = {
    get: {
      operationId: "getHandleTimeTrend",
      summary: "Average call duration bucketed over time (platform extension)",
      description:
        "Average call duration (duration_seconds) grouped into hourly or daily " +
        "buckets over the given window. Not part of the standard's documented API.",
      tags: ["Insights"],
      parameters: [...windowParams, bucketParam],
      responses: {
        "200": {
          description: "Time-bucketed average handle time",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        bucketStart: { type: "string", format: "date-time" },
                        avgSeconds: { type: "integer" },
                        callCount: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
      },
    },
  };

  spec.paths["/statistics/handle-time/by-agent"] = {
    get: {
      operationId: "getAgentHandleTime",
      summary: "Agents ranked by average handle time (platform extension)",
      description:
        "Agents (participants who carried a userId on at least one call) ranked " +
        "by average call duration, longest first. Agents with only a single call " +
        "are excluded. Not part of the standard's documented API.",
      tags: ["Insights"],
      parameters: [...windowParams, limitParam],
      responses: {
        "200": {
          description: "Agents ranked by average handle time",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        identity: { type: "string" },
                        displayName: { type: "string", nullable: true },
                        callCount: { type: "integer" },
                        avgDurationSeconds: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
      },
    },
  };

  spec.paths["/statistics/queue-wait"] = {
    get: {
      operationId: "getQueueWaitTrend",
      summary: "Average queue wait time bucketed over time (platform extension)",
      description:
        "Average time in queue (callSource.timeInQueueSeconds) grouped into " +
        "hourly or daily buckets over the given window, counting only calls " +
        "that passed through a queue. Not part of the standard's documented API.",
      tags: ["Insights"],
      parameters: [...windowParams, bucketParam],
      responses: {
        "200": {
          description: "Time-bucketed average queue wait",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        bucketStart: { type: "string", format: "date-time" },
                        avgSeconds: { type: "integer" },
                        callCount: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
      },
    },
  };

  spec.paths["/statistics/queue-wait/by-queue"] = {
    get: {
      operationId: "getQueueWaitBreakdown",
      summary: "Queues ranked by average wait time (platform extension)",
      description:
        "Queues (callSource.queueInfo) ranked by average time in queue, longest " +
        "first. Not part of the standard's documented API.",
      tags: ["Insights"],
      parameters: [...windowParams, limitParam],
      responses: {
        "200": {
          description: "Queues ranked by average wait time",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        queueId: { type: "string" },
                        callCount: { type: "integer" },
                        avgWaitSeconds: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
      },
    },
  };

  spec.paths["/admin/backups"] = {
    get: {
      operationId: "getBackupStatus",
      summary: "Scheduled backup status (platform extension)",
      description:
        "Read-only metadata on the pg_dump files written by the `backup` " +
        "compose service (scripts/backup.sh) — filenames, sizes, timestamps, " +
        "plus the configured retention/interval. Reports only; cannot trigger " +
        "or delete a backup, so it carries no auth, like the rest of the read API. " +
        "Not part of the standard's documented API.",
      tags: ["Admin"],
      responses: {
        "200": {
          description: "Backup status",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        filename: { type: "string" },
                        sizeBytes: { type: "integer" },
                        createdAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                  retentionDays: { type: "integer" },
                  intervalHours: { type: "integer" },
                  configured: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
    post: {
      operationId: "triggerBackup",
      summary: "Trigger a pg_dump now (platform extension)",
      description:
        "Runs pg_dump (custom format) immediately and writes it alongside the " +
        "scheduled backups. Not part of the standard's documented API.",
      tags: ["Admin"],
      security: [{ ApiKeyAuth: [] }],
      responses: {
        "201": {
          description: "Backup created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  filename: { type: "string" },
                  sizeBytes: { type: "integer" },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  };

  spec.paths["/admin/backups/{filename}/download"] = {
    get: {
      operationId: "downloadBackup",
      summary: "Download a backup file (platform extension)",
      description:
        "Streams a pg_dump (custom format) file. Not part of the standard's documented API.",
      tags: ["Admin"],
      security: [{ ApiKeyAuth: [] }],
      parameters: [
        { name: "filename", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "The dump file",
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { description: "Backup not found" },
      },
    },
  };

  spec.paths["/admin/backups/restore"] = {
    post: {
      operationId: "restoreBackup",
      summary: "Restore the database from a backup (platform extension)",
      description:
        "Destructive — pg_restore --clean --if-exists drops conflicting objects " +
        "before restoring from the uploaded pg_dump (custom format) file. Not " +
        "part of the standard's documented API.",
      tags: ["Admin"],
      security: [{ ApiKeyAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/octet-stream": { schema: { type: "string", format: "binary" } },
        },
      },
      responses: {
        "200": {
          description: "Restored",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { ok: { type: "boolean" }, message: { type: "string" } },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  };

  spec.tags = spec.tags ?? [];
  if (!spec.tags.some((t: any) => t.name === "Ingest")) {
    spec.tags.push({
      name: "Ingest",
      description: "Record ingestion (platform extension)",
    });
  }
  if (!spec.tags.some((t: any) => t.name === "Insights")) {
    spec.tags.push({
      name: "Insights",
      description: "Reporting & insights — top talkers, throughput (platform extension)",
    });
  }
  if (!spec.tags.some((t: any) => t.name === "Admin")) {
    spec.tags.push({
      name: "Admin",
      description: "Operational status & actions — backups, etc. (platform extension)",
    });
  }

  spec.components = spec.components ?? {};
  spec.components.securitySchemes = spec.components.securitySchemes ?? {};
  spec.components.securitySchemes.ApiKeyAuth = {
    type: "apiKey",
    in: "header",
    name: "X-API-Key",
  };

  return spec;
}

export const openApiSpec = loadSpec();
