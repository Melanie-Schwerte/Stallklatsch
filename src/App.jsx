import { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";

const STATUS = {
  kein: { label: "Kein Service", short: "Kein Service", color: "#8A8A7E", bg: "#EDEDE6" },
  weide_normal: { label: "Weidedienst normal", short: "Weide normal", color: "#6B8F58", bg: "#EAF0E4" },
  nur_raus: { label: "Nur raus", short: "Nur raus", color: "#C9762B", bg: "#FBEFE1" },
  nur_rein_frueh: { label: "Nur rein – früh", short: "Nur rein früh", color: "#A85B3B", bg: "#F3E4DB" },
  nur_rein_spaet: { label: "Nur rein – spät", short: "Nur rein spät", color: "#8B5E3C", bg: "#F1E7DD" },
};

const STATUS_ORDER = ["weide_normal", "nur_raus", "nur_rein_frueh", "nur_rein_spaet", "kein"];

export default function App() {
  const [horses, setHorses] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newPin, setNewPin] = useState("");
  const [filter, setFilter] = useState(null);
  const [unlockedIds, setUnlockedIds] = useState(() => new Set());
  const [pinDrafts, setPinDrafts] = useState({});
  const [pinErrors, setPinErrors] = useState({});
  const [commentDrafts, setCommentDrafts] = useState({});
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await supabase
      .from("horses")
      .select("*")
      .order("name", { ascending: true });
    if (err) {
      setError("Laden fehlgeschlagen: " + err.message);
    } else {
      setHorses(data);
      setError(null);
    }
    setLoading(false);
    setLastRefreshed(Date.now());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Echtzeit-Abo: Änderungen von anderen erscheinen sofort, kein Polling nötig
  useEffect(() => {
    const channel = supabase
      .channel("horses-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "horses" },
        () => {
          load();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  async function setStatus(id, status) {
    const { error: err } = await supabase
      .from("horses")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (err) setError("Speichern fehlgeschlagen: " + err.message);
  }

  async function saveComment(id, text) {
    const { error: err } = await supabase
      .from("horses")
      .update({ comment: text })
      .eq("id", id);
    if (err) setError("Speichern fehlgeschlagen: " + err.message);
  }

  async function addHorse(e) {
    e.preventDefault();
    const name = newName.trim();
    const pin = newPin.trim();
    if (!name || !pin) return;
    const { data, error: err } = await supabase
      .from("horses")
      .insert({
        name,
        owner: newOwner.trim(),
        pin,
        status: "weide_normal",
        comment: "",
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (err) {
      setError("Eintragen fehlgeschlagen: " + err.message);
      return;
    }
    setUnlockedIds((prev) => new Set(prev).add(data.id));
    setNewName("");
    setNewOwner("");
    setNewPin("");
    setShowAdd(false);
    load();
  }

  async function removeHorse(id) {
    const { error: err } = await supabase.from("horses").delete().eq("id", id);
    if (err) setError("Entfernen fehlgeschlagen: " + err.message);
    load();
  }

  function tryUnlock(id) {
    const horse = horses.find((h) => h.id === id);
    const attempt = (pinDrafts[id] || "").trim();
    if (horse && attempt && attempt === horse.pin) {
      setUnlockedIds((prev) => new Set(prev).add(id));
      setPinErrors((prev) => ({ ...prev, [id]: null }));
      setPinDrafts((prev) => ({ ...prev, [id]: "" }));
    } else {
      setPinErrors((prev) => ({ ...prev, [id]: "Code stimmt nicht." }));
    }
  }

  function timeAgo(ts) {
    if (!ts) return "unbekannt";
    const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    if (mins < 1) return "gerade eben";
    if (mins < 60) return `vor ${mins} Min.`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `vor ${hrs} Std.`;
    return `vor ${Math.round(hrs / 24)} Tg.`;
  }

  const counts = {};
  STATUS_ORDER.forEach((k) => (counts[k] = 0));
  (horses || []).forEach((h) => {
    if (counts[h.status] !== undefined) counts[h.status] += 1;
  });
  const total = (horses || []).length;

  const visibleGroups = STATUS_ORDER.filter((k) => !filter || filter === k)
    .map((k) => ({
      key: k,
      horses: (horses || [])
        .filter((h) => h.status === k)
        .sort((a, b) => a.name.localeCompare(b.name, "de")),
    }))
    .filter((g) => g.horses.length > 0);

  return (
    <div style={styles.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        button { font-family: inherit; cursor: pointer; }
        input, textarea { font-family: inherit; }
        .card { transition: transform 0.15s ease, box-shadow 0.15s ease; }
        .card:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(20,26,17,0.18); }
        .statusBtn { transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease; }
        .peg { transition: transform 0.15s ease; }
        .card:hover .peg { transform: rotate(-4deg); }
        @media (prefers-reduced-motion: reduce) {
          .card, .statusBtn, .peg { transition: none !important; }
        }
      `}</style>

      <header style={styles.header}>
        <div>
          <div style={styles.eyebrow}>STALLTAFEL</div>
          <h1 style={styles.title}>Wer geht wann rein?</h1>
          {lastRefreshed && (
            <div style={styles.refreshNote}>
              ● Live – zuletzt aktualisiert um{" "}
              {new Date(lastRefreshed).toLocaleTimeString("de-DE", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          )}
        </div>
        <button onClick={() => setShowAdd((s) => !s)} style={styles.addBtn}>
          {showAdd ? "Abbrechen" : "+ Pferd eintragen"}
        </button>
      </header>

      {showAdd && (
        <form onSubmit={addHorse} style={styles.addForm}>
          <input
            style={styles.input}
            placeholder="Name des Pferdes"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
          />
          <input
            style={styles.input}
            placeholder="Besitzer (optional)"
            value={newOwner}
            onChange={(e) => setNewOwner(e.target.value)}
          />
          <input
            style={styles.input}
            placeholder="Code (z. B. 4-stellig) – zum Ändern nötig"
            value={newPin}
            onChange={(e) => setNewPin(e.target.value)}
          />
          <button type="submit" style={styles.saveBtn}>
            Eintragen
          </button>
        </form>
      )}

      {error && <div style={styles.errorBanner}>{error}</div>}
      {loading && <div style={styles.empty}>Stalltafel wird geladen …</div>}
      {!loading && horses && horses.length === 0 && (
        <div style={styles.empty}>Noch keine Pferde eingetragen. Leg mit „+ Pferd eintragen" los.</div>
      )}

      {!loading && horses && horses.length > 0 && (
        <div style={styles.filterBar}>
          <button
            onClick={() => setFilter(null)}
            style={{
              ...styles.chip,
              background: filter === null ? "#EFE8D8" : "transparent",
              color: filter === null ? "#26332A" : "#EFE8D8",
              borderColor: "#5C6E5E",
            }}
          >
            Alle · {total}
          </button>
          {STATUS_ORDER.map((k) => {
            const s = STATUS[k];
            const active = filter === k;
            if (counts[k] === 0) return null;
            return (
              <button
                key={k}
                onClick={() => setFilter(active ? null : k)}
                style={{
                  ...styles.chip,
                  background: active ? s.color : "transparent",
                  color: active ? "#fff" : s.color,
                  borderColor: s.color,
                }}
              >
                {s.short} · {counts[k]}
              </button>
            );
          })}
        </div>
      )}

      {!loading &&
        horses &&
        visibleGroups.map((group) => {
          const s = STATUS[group.key];
          return (
            <section key={group.key} style={styles.section}>
              <div style={styles.sectionHeader}>
                <span style={{ ...styles.sectionDot, background: s.color }} />
                <h2 style={styles.sectionTitle}>{s.label}</h2>
                <span style={styles.sectionCount}>{group.horses.length}</span>
              </div>
              <div style={styles.grid}>
                {group.horses.map((h) => (
                  <div key={h.id} className="card" style={{ ...styles.card, borderColor: s.color }}>
                    <div className="peg" style={{ ...styles.peg, background: s.color }} />
                    <button
                      onClick={() => removeHorse(h.id)}
                      style={styles.removeBtn}
                      title="Entfernen"
                    >
                      ×
                    </button>
                    <div style={styles.cardName}>{h.name}</div>
                    {h.owner && <div style={styles.cardOwner}>{h.owner}</div>}

                    <div style={{ ...styles.statusTag, background: s.bg, color: s.color }}>
                      {s.label}
                    </div>

                    {unlockedIds.has(h.id) ? (
                      <div style={styles.btnRow}>
                        {STATUS_ORDER.map((key) => {
                          const st = STATUS[key];
                          const active = h.status === key;
                          return (
                            <button
                              key={key}
                              className="statusBtn"
                              onClick={() => setStatus(h.id, key)}
                              style={{
                                ...styles.statusBtn,
                                background: active ? st.color : "transparent",
                                color: active ? "#fff" : st.color,
                                borderColor: st.color,
                              }}
                            >
                              {st.short}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div style={styles.lockBox}>
                        <div style={styles.lockLabel}>🔒 Gesperrt – Code eingeben</div>
                        <div style={styles.lockRow}>
                          <input
                            style={styles.pinInput}
                            type="password"
                            inputMode="numeric"
                            placeholder="Code"
                            value={pinDrafts[h.id] || ""}
                            onChange={(e) =>
                              setPinDrafts((prev) => ({ ...prev, [h.id]: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") tryUnlock(h.id);
                            }}
                          />
                          <button style={styles.unlockBtn} onClick={() => tryUnlock(h.id)}>
                            Entsperren
                          </button>
                        </div>
                        {pinErrors[h.id] && <div style={styles.pinError}>{pinErrors[h.id]}</div>}
                      </div>
                    )}

                    <div style={styles.timestamp}>Zuletzt geändert {timeAgo(h.updated_at)}</div>

                    <textarea
                      style={styles.commentBox}
                      placeholder="Platz für Kommentar, falls nötig"
                      value={commentDrafts[h.id] !== undefined ? commentDrafts[h.id] : h.comment || ""}
                      onChange={(e) =>
                        setCommentDrafts((prev) => ({ ...prev, [h.id]: e.target.value }))
                      }
                      onBlur={(e) => saveComment(h.id, e.target.value.trim())}
                      rows={2}
                    />
                  </div>
                ))}
              </div>
            </section>
          );
        })}

      <div style={styles.footnote}>
        Jedes Pferd ist mit einem Code gesperrt, den der Ersteller beim Eintragen vergibt. Das ist
        kein echter Zugriffsschutz, sondern verhindert versehentliches Ändern durch andere.
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#26332A",
    backgroundImage: "radial-gradient(circle at 15% 10%, rgba(255,255,255,0.03), transparent 40%)",
    padding: "40px 24px 60px",
    fontFamily: "'IBM Plex Mono', monospace",
    color: "#EFE8D8",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    flexWrap: "wrap",
    gap: 16,
    maxWidth: 1000,
    margin: "0 auto 8px",
  },
  eyebrow: { fontSize: 12, letterSpacing: "0.18em", color: "#C9A227", marginBottom: 6 },
  refreshNote: { fontSize: 11, color: "#8FAF8A", marginTop: 6 },
  title: {
    fontFamily: "'Fraunces', serif",
    fontWeight: 600,
    fontSize: "clamp(28px, 4vw, 42px)",
    margin: 0,
    color: "#F7F3E8",
  },
  addBtn: {
    background: "#C9A227",
    color: "#26332A",
    border: "none",
    borderRadius: 8,
    padding: "12px 18px",
    fontSize: 14,
    fontWeight: 600,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  addForm: {
    maxWidth: 1000,
    margin: "20px auto 0",
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    background: "#2E3D31",
    padding: 16,
    borderRadius: 10,
    border: "1px solid #3E4F41",
  },
  input: {
    flex: "1 1 200px",
    padding: "10px 12px",
    borderRadius: 6,
    border: "1px solid #4A5D4D",
    background: "#26332A",
    color: "#F7F3E8",
    fontSize: 14,
  },
  saveBtn: {
    background: "#6B8F58",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "10px 18px",
    fontSize: 14,
    fontWeight: 600,
  },
  errorBanner: {
    maxWidth: 1000,
    margin: "16px auto 0",
    background: "#4A2E2E",
    color: "#F2C6C6",
    padding: "10px 14px",
    borderRadius: 6,
    fontSize: 13,
  },
  empty: { maxWidth: 1000, margin: "40px auto", textAlign: "center", color: "#A9B7A9", fontSize: 14 },
  filterBar: { maxWidth: 1000, margin: "22px auto 0", display: "flex", gap: 8, flexWrap: "wrap" },
  chip: {
    border: "1.5px solid",
    borderRadius: 999,
    padding: "6px 14px",
    fontSize: 12.5,
    fontWeight: 600,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  section: { maxWidth: 1000, margin: "30px auto 0" },
  sectionHeader: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 },
  sectionDot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  sectionTitle: {
    fontFamily: "'Fraunces', serif",
    fontWeight: 600,
    fontSize: 19,
    margin: 0,
    color: "#F7F3E8",
  },
  sectionCount: {
    fontSize: 12,
    color: "#9CB09E",
    background: "#2E3D31",
    border: "1px solid #4A5D4D",
    borderRadius: 999,
    padding: "2px 9px",
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14 },
  card: {
    position: "relative",
    background: "#F7F3E8",
    color: "#2A2A24",
    borderRadius: 10,
    borderTop: "5px solid",
    padding: "16px 16px 12px",
    boxShadow: "0 4px 10px rgba(20,26,17,0.14)",
  },
  peg: {
    position: "absolute",
    top: -9,
    left: 20,
    width: 14,
    height: 14,
    borderRadius: "50%",
    boxShadow: "0 2px 4px rgba(0,0,0,0.25)",
  },
  removeBtn: {
    position: "absolute",
    top: 10,
    right: 10,
    background: "none",
    border: "none",
    fontSize: 18,
    color: "#B7ADA0",
    lineHeight: 1,
    padding: 4,
  },
  cardName: { fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 22, marginBottom: 2 },
  cardOwner: { fontSize: 12, color: "#7A7568", marginBottom: 10 },
  statusTag: {
    display: "inline-block",
    fontSize: 12,
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: 999,
    marginBottom: 12,
  },
  btnRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  statusBtn: {
    border: "1.5px solid",
    borderRadius: 6,
    padding: "7px 6px",
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1.25,
    whiteSpace: "normal",
  },
  lockBox: { background: "#EFEAE0", border: "1px dashed #C9BFA9", borderRadius: 8, padding: "10px 10px" },
  lockLabel: { fontSize: 11.5, fontWeight: 600, color: "#7A7568", marginBottom: 8 },
  lockRow: { display: "flex", gap: 6 },
  pinInput: {
    flex: 1,
    minWidth: 0,
    padding: "7px 8px",
    borderRadius: 6,
    border: "1px solid #C9BFA9",
    fontSize: 13,
    background: "#fff",
  },
  unlockBtn: {
    background: "#26332A",
    color: "#EFE8D8",
    border: "none",
    borderRadius: 6,
    padding: "7px 10px",
    fontSize: 11.5,
    fontWeight: 600,
  },
  pinError: { marginTop: 6, fontSize: 11, color: "#B23B3B" },
  timestamp: { marginTop: 12, fontSize: 11, color: "#9A9482" },
  commentBox: {
    width: "100%",
    marginTop: 10,
    padding: "8px 9px",
    borderRadius: 6,
    border: "1px solid #DCD4C2",
    background: "#FBF9F3",
    color: "#2A2A24",
    fontSize: 12,
    fontFamily: "'IBM Plex Mono', monospace",
    resize: "vertical",
  },
  footnote: { maxWidth: 1000, margin: "30px auto 0", textAlign: "center", fontSize: 12, color: "#8A9A8C" },
};
