import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Employee } from "@/lib/api";
import { EmployeeAvatar } from "@/components/ui/employee-avatar";
import { useSettings } from "@/routes/settings-provider";
import { emojiForName } from "@/lib/emoji-pool";
import { EmojiPicker } from "@/components/ui/emoji-picker";

interface SessionData {
  id: string;
  employee?: string | null;
  status?: string;
  createdAt?: string;
  source?: string;
  [key: string]: unknown;
}

function RankBadge({ rank }: { rank: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    executive: {
      bg: "color-mix(in srgb, var(--system-purple) 15%, transparent)",
      text: "var(--system-purple)",
    },
    manager: {
      bg: "color-mix(in srgb, var(--system-blue) 15%, transparent)",
      text: "var(--system-blue)",
    },
    senior: {
      bg: "color-mix(in srgb, var(--system-green) 15%, transparent)",
      text: "var(--system-green)",
    },
    employee: {
      bg: "var(--fill-tertiary)",
      text: "var(--text-tertiary)",
    },
  };
  const c = colors[rank] || colors.employee;

  return (
    <span
      className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] px-[10px] py-[2px] rounded-[10px] uppercase tracking-[0.02em]"
      style={{ color: c.text, background: c.bg }}
    >
      {rank}
    </span>
  );
}

export function EmployeeDetail({ name, prefetched }: { name: string; prefetched?: Employee }) {
  const [employee, setEmployee] = useState<Employee | null>(prefetched ?? null);
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [loading, setLoading] = useState(!prefetched);
  const [error, setError] = useState<string | null>(null);
  const [personaExpanded, setPersonaExpanded] = useState(false);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const { settings, setEmployeeOverride } = useSettings();

  useEffect(() => {
    setPersonaExpanded(false);

    if (prefetched) {
      setEmployee(prefetched);
      setLoading(true);
      setError(null);
      api.getSessionsForGroup(name, 0, 10)
        .then((empSessions) => setSessions(empSessions as SessionData[]))
        .catch(() => setSessions([]))
        .finally(() => setLoading(false));
      return;
    }

    setLoading(true);
    setError(null);

    Promise.all([api.getEmployee(name), api.getSessionsForGroup(name, 0, 10)])
      .then(([emp, empSessions]) => {
        setEmployee(emp);
        setSessions(empSessions as SessionData[]);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [name, prefetched]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="rounded-[var(--radius-md,12px)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--system-red)]"
        style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)" }}
      >
        Failed to load employee: {error}
      </div>
    );
  }

  if (!employee) return null;

  const rank = employee.rank || "employee";
  const persona = employee.persona || "";
  const currentEmoji = settings.employeeOverrides[employee.name]?.emoji || emojiForName(employee.name);
  const truncatedPersona =
    persona.length > 200 && !personaExpanded
      ? persona.slice(0, 200) + "..."
      : persona;

  return (
    <div className="flex flex-col gap-[var(--space-6)]">
      {/* Main info card */}
      <div className="rounded-[var(--radius-lg,16px)] border border-[var(--separator)] bg-[var(--material-regular)] p-[var(--space-6)]">
        <div className="flex items-start justify-between mb-[var(--space-4)]">
          <div className="flex items-center gap-[var(--space-3)]">
            <div className="relative">
              <EmployeeAvatar
                name={employee.name}
                size={36}
                onClick={() => setShowAvatarPicker(!showAvatarPicker)}
              />
              {showAvatarPicker && (
                <EmojiPicker
                  current={currentEmoji}
                  onSelect={(emoji) => {
                    setEmployeeOverride(employee.name, { emoji: emoji === emojiForName(employee.name) ? undefined : emoji });
                    setShowAvatarPicker(false);
                  }}
                  onClose={() => setShowAvatarPicker(false)}
                />
              )}
            </div>
            <div>
              <h2 className="text-[length:var(--text-title2)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] m-0">
                {employee.displayName || employee.name}
              </h2>
              <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-[2px] mb-0 ml-0 mr-0 font-[family-name:var(--font-mono)]">
                {employee.name}
              </p>
            </div>
          </div>
          <RankBadge rank={rank} />
        </div>

        <div className="grid grid-cols-2 gap-[var(--space-4)]">
          <div>
            <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
              Department
            </p>
            <p className="text-[length:var(--text-body)] text-[var(--text-primary)] m-0">
              {employee.department || "None"}
            </p>
          </div>
          <div>
            <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
              Engine
            </p>
            <p className="text-[length:var(--text-body)] text-[var(--text-primary)] m-0">
              {employee.engine || "claude"}{" "}
              <span className="text-[var(--text-tertiary)]">
                / {employee.model || "default"}
              </span>
            </p>
          </div>
        </div>

        {persona && (
          <div className="mt-[var(--space-4)] pt-[var(--space-4)] border-t border-[var(--separator)]">
            <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
              Persona
            </p>
            <p className="text-[length:var(--text-body)] text-[var(--text-secondary)] leading-[var(--leading-relaxed)] whitespace-pre-wrap m-0">
              {truncatedPersona}
            </p>
            {persona.length > 200 && (
              <button
                onClick={() => setPersonaExpanded(!personaExpanded)}
                className="text-[length:var(--text-caption1)] text-[var(--accent)] bg-none border-none cursor-pointer p-0 mt-[var(--space-1)]"
              >
                {personaExpanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Recent Sessions */}
      <div>
        <h3 className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] tracking-[var(--tracking-wide)] uppercase text-[var(--text-tertiary)] mb-[var(--space-3)]">
          Recent Sessions
        </h3>
        {sessions.length === 0 ? (
          <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] text-center py-[var(--space-6)] px-0">
            No sessions found for this employee.
          </p>
        ) : (
          <div className="rounded-[var(--radius-lg,16px)] border border-[var(--separator)] bg-[var(--material-regular)] overflow-hidden">
            {sessions.map((session, idx) => (
              <div
                key={session.id}
                className={`px-[var(--space-5)] py-[var(--space-3)] flex items-center justify-between${idx > 0 ? " border-t border-[var(--separator)]" : ""}`}
              >
                <div>
                  <p className="text-[length:var(--text-body)] font-[family-name:var(--font-mono)] text-[var(--text-primary)] m-0">
                    {session.id.slice(0, 8)}
                  </p>
                  <p className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mt-[2px]">
                    {session.source || "unknown"}{" "}
                    {session.createdAt
                      ? new Date(session.createdAt).toLocaleDateString()
                      : ""}
                  </p>
                </div>
                <span
                  className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] py-[2px] px-[8px] rounded-[10px]"
                  style={
                    session.status === "running"
                      ? {
                          background:
                            "color-mix(in srgb, var(--system-green) 15%, transparent)",
                          color: "var(--system-green)",
                        }
                      : session.status === "error"
                        ? {
                            background:
                              "color-mix(in srgb, var(--system-red) 15%, transparent)",
                            color: "var(--system-red)",
                          }
                        : {
                            background: "var(--fill-tertiary)",
                            color: "var(--text-tertiary)",
                          }
                  }
                >
                  {session.status || "idle"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
