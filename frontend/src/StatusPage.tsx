import { useEffect, useState } from "react";
import { api, PublicStatus } from "./api";
import { C, MONO, SANS } from "./App";

// Rendered instead of the authenticated dashboard when the URL is /status —
// see main.tsx. Deliberately its own small component, not a route inside
// App() (which has no router and assumes a logged-in shell), since this is
// the one page in the whole product meant to work for someone who has never
// logged in and never will.
export default function StatusPage() {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);

  useEffect(() => {
    api
      .publicStatus()
      .then(setStatus)
      .catch(() => setNotEnabled(true));
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        color: C.ink,
        fontFamily: SANS,
        display: "flex",
        justifyContent: "center",
        padding: "48px 20px",
      }}
    >
      <div style={{ width: "100%", maxWidth: 480 }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>CallOwl status</div>

        {notEnabled ? (
          <div
            style={{
              padding: "14px 16px",
              borderRadius: 10,
              background: C.surface,
              border: `1px solid ${C.border}`,
              color: C.textMuted,
              fontSize: 13.5,
            }}
          >
            This status page isn't enabled.
          </div>
        ) : !status ? (
          <div style={{ color: C.textMuted, fontSize: 13.5 }}>Loading…</div>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "14px 16px",
                borderRadius: 10,
                background: status.status === "operational" ? C.tealSoft : C.roseSoft,
                border: `1px solid ${(status.status === "operational" ? C.teal : C.rose)}44`,
                marginBottom: 16,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: status.status === "operational" ? C.teal : C.rose,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontSize: 14.5,
                  fontWeight: 650,
                  color: status.status === "operational" ? C.teal : C.rose,
                }}
              >
                {status.status === "operational"
                  ? "All systems operational"
                  : "Experiencing an outage"}
              </span>
            </div>

            <div
              style={{
                borderRadius: 10,
                background: C.surface,
                border: `1px solid ${C.border}`,
                overflow: "hidden",
              }}
            >
              {status.components.map((c, i) => (
                <div
                  key={c.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "12px 16px",
                    borderTop: i > 0 ? `1px solid ${C.border}` : undefined,
                  }}
                >
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>{c.name}</span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 650,
                      color: c.status === "operational" ? C.teal : C.rose,
                    }}
                  >
                    {c.status === "operational" ? "Operational" : "Unavailable"}
                  </span>
                </div>
              ))}
            </div>

            <div
              style={{
                marginTop: 16,
                fontSize: 11.5,
                color: C.textMuted,
                fontFamily: MONO,
                textAlign: "center",
              }}
            >
              Last checked {new Date(status.timestamp).toLocaleString()} · v{status.apiVersion}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
