import { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "./supabaseClient";

const STATUS = {
  kein: { label: "Kein Service", short: "Kein Service" },
  weide_normal: { label: "Weidedienst normal", short: "Weide normal" },
  nur_raus: { label: "Nur raus", short: "Nur raus" },
  nur_rein_frueh: { label: "Nur rein – früh", short: "Früh rein" },
  nur_rein_spaet: { label: "Nur rein – spät", short: "Spät rein" },
};
const STATUS_ORDER = ["weide_normal", "nur_raus", "nur_rein_frueh", "nur_rein_spaet", "kein"];

// Drei Farb-Buckets, wie gewünscht: voll / halb / kein
function bucketOf(status) {
  if (status === "weide_normal") return "voll";
  if (status === "kein") return "kein";
  return "halb";
}
const BUCKET = {
  voll: { bg: "#DCEBD3", border: "#6B8F58", text: "#3E5A32", label: "Vollservice" },
  halb: { bg: "#FBE6CF", border: "#C9762B", text: "#8A4E1C", label: "Halbservice" },
  kein: { bg: "#E7E5DE", border: "#A9A492", text: "#6B675B", label: "Kein Service" },
};

export default function App() {
  const [paddocks, setPaddocks] = useState([]);
  const [horses, setHorses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [adminPinDraft, setAdminPinDraft] = useState("");
  const [adminError, setAdminError] = useState(null);
  const [adminPinValue, setAdminPinValue] = useState(null); // aus app_settings geladen
  const [showAdminPanel, setShowAdminPanel] = useState(false);

  const [filterBucket, setFilterBucket] = useState(null);
  const [selected, setSelected] = useState(null); // { horseId } oder { newForPaddock, slot }
  const [unlockedIds, setUnlockedIds] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: p, error: pErr }, { data: h, error: hErr }, { data: s }] = await Promise.all([
      supabase.from("paddocks").select("*").order("order_index", { ascending: true }),
      supabase.from("horses").select("*"),
      supabase.from("app_settings").select("*").eq("id", 1).single(),
    ]);
    if (pErr || hErr) {
      setError("Laden fehlgeschlagen: " + (pErr?.message || hErr?.message));
    } else {
      setPaddocks(p || []);
      setHorses(h || []);
      setAdminPinValue(s?.admin_pin || null);
      setError(null);
    }
    setLoading(false);
    setLastRefreshed(Date.now());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const channel = supabase
      .channel("weideplan-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "horses" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "paddocks" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, load)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [load]);

  const horsesByPaddock = useMemo(() => {
    const map = {};
    horses.forEach((h) => {
      if (!h.paddock_id) return;
      if (!map[h.paddock_id]) map[h.paddock_id] = {};
      map[h.paddock_id][h.slot_index] = h;
    });
    return map;
  }, [horses]);

  const unassignedHorses = horses.filter((h) => !h.paddock_id);

  const counts = { voll: 0, halb: 0, kein: 0 };
  horses.forEach((h) => (counts[bucketOf(h.status)] += 1));

  function tryAdminLogin() {
    if (adminPinValue && adminPinDraft.trim() === adminPinValue) {
      setAdminUnlocked(true);
      setAdminError(null);
      setShowAdminLogin(false);
      setAdminPinDraft("");
    } else {
      setAdminError("Admin-Code stimmt nicht.");
    }
  }

  async function setStatus(id, status) {
    const { error: err } = await supabase
      .from("horses")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (err) setError("Speichern fehlgeschlagen: " + err.message);
  }

  async function saveComment(id, text) {
    const { error: err } = await supabase.from("horses").update({ comment: text }).eq("id", id);
    if (err) setError("Speichern fehlgeschlagen: " + err.message);
  }

  async function moveHorse(id, paddockId, slotIndex) {
    const { error: err } = await supabase
      .from("horses")
      .update({ paddock_id: paddockId, slot_index: slotIndex })
      .eq("id", id);
    if (err) setError("Verschieben fehlgeschlagen: " + err.message);
  }

  async function deleteHorse(id) {
    const { error: err } = await supabase.from("horses").delete().eq("id", id);
    if (err) setError("Entfernen fehlgeschlagen: " + err.message);
    setSelected(null);
  }

  async function addHorse({ name, owner, pin, paddockId, slotIndex }) {
    const { error: err } = await supabase.from("horses").insert({
      name,
      owner,
      pin,
      status: "weide_normal",
      comment: "",
      paddock_id: paddockId || null,
      slot_index: slotIndex,
      updated_at: new Date().toISOString(),
    });
    if (err) setError("Eintragen fehlgeschlagen: " + err.message);
    setSelected(null);
  }

  function freeSlotIn(paddockId) {
    const p = paddocks.find((pp) => pp.id === paddockId);
    if (!p) return null;
    const occupied = horsesByPaddock[paddockId] || {};
    for (let i = 0; i < p.slot_count; i++) {
      if (!occupied[i]) return i;
    }
    return null;
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

  // Rendert die Weiden in Papierplan-Reihenfolge, mit Abschnitts-Überschriften
  const rows = [];
  let lastSectionTitle = null;
  paddocks.forEach((p) => {
    if (p.section_title && p.section_title !== lastSectionTitle) {
      rows.push({ type: "heading", key: "h-" + p.id, title: p.section_title });
      lastSectionTitle = p.section_title;
    } else if (!p.section_title) {
      lastSectionTitle = null;
    }
    rows.push({ type: "paddock", key: p.id, paddock: p });
  });

  return (
    <div style={styles.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        button { font-family: inherit; cursor: pointer; }
        input, textarea, select { font-family: inherit; }
        .cell { transition: transform 0.1s ease, box-shadow 0.1s ease, opacity 0.15s ease; }
        .cell:active { transform: scale(0.97); }
        @media (prefers-reduced-motion: reduce) { .cell { transition: none !important; } }
      `}</style>

      <header style={styles.header}>
        <div>
          <div style={styles.eyebrow}>WEIDEPLAN</div>
          <h1 style={styles.title}>Wer geht wann rein?</h1>
          {lastRefreshed && (
            <div style={styles.refreshNote}>
              ● Live – {new Date(lastRefreshed).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
            </div>
          )}
        </div>
        <div style={styles.headerBtns}>
          {adminUnlocked ? (
            <button style={styles.adminActiveBtn} onClick={() => setShowAdminPanel((s) => !s)}>
              🔑 Admin {showAdminPanel ? "▲" : "▼"}
            </button>
          ) : (
            <button style={styles.adminBtn} onClick={() => setShowAdminLogin((s) => !s)}>
              🔑 Admin
            </button>
          )}
        </div>
      </header>

      {showAdminLogin && !adminUnlocked && (
        <div style={styles.adminLoginBox}>
          <input
            style={styles.pinInput}
            type="password"
            placeholder="Admin-Code"
            value={adminPinDraft}
            onChange={(e) => setAdminPinDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && tryAdminLogin()}
          />
          <button style={styles.unlockBtn} onClick={tryAdminLogin}>
            Anmelden
          </button>
          {adminError && <div style={styles.pinError}>{adminError}</div>}
        </div>
      )}

      {error && <div style={styles.errorBanner}>{error}</div>}
      {loading && <div style={styles.empty}>Weideplan wird geladen …</div>}

      {!loading && (
        <div style={styles.filterBar}>
          <button
            onClick={() => setFilterBucket(null)}
            style={{ ...styles.chip, ...(filterBucket === null ? styles.chipActive : {}) }}
          >
            Alle · {horses.length}
          </button>
          {["voll", "halb", "kein"].map((b) => (
            <button
              key={b}
              onClick={() => setFilterBucket(filterBucket === b ? null : b)}
              style={{
                ...styles.chip,
                borderColor: BUCKET[b].border,
                color: filterBucket === b ? "#fff" : BUCKET[b].text,
                background: filterBucket === b ? BUCKET[b].border : "transparent",
              }}
            >
              {BUCKET[b].label} · {counts[b]}
            </button>
          ))}
        </div>
      )}

      {adminUnlocked && showAdminPanel && (
        <AdminPanel paddocks={paddocks} adminPinValue={adminPinValue} onReload={load} setError={setError} />
      )}

      {!loading && (
        <div style={styles.list}>
          {rows.map((row) =>
            row.type === "heading" ? (
              <div key={row.key} style={styles.sectionHeading}>
                {row.title}
              </div>
            ) : (
              <PaddockRow
                key={row.key}
                paddock={row.paddock}
                horsesInSlot={horsesByPaddock[row.paddock.id] || {}}
                filterBucket={filterBucket}
                onCellClick={(slotIndex, horse) =>
                  setSelected(horse ? { horseId: horse.id } : { newForPaddock: row.paddock.id, slot: slotIndex })
                }
              />
            )
          )}

          {unassignedHorses.length > 0 && (
            <>
              <div style={styles.sectionHeading}>Nicht zugeordnet</div>
              <div style={styles.paddockRow}>
                <div style={styles.slotsWrap}>
                  {unassignedHorses.map((h) => (
                    <HorseCell
                      key={h.id}
                      horse={h}
                      filterBucket={filterBucket}
                      onClick={() => setSelected({ horseId: h.id })}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {selected && (
        <DetailModal
          selected={selected}
          horses={horses}
          paddocks={paddocks}
          adminUnlocked={adminUnlocked}
          unlockedIds={unlockedIds}
          setUnlockedIds={setUnlockedIds}
          freeSlotIn={freeSlotIn}
          onClose={() => setSelected(null)}
          onSetStatus={setStatus}
          onSaveComment={saveComment}
          onMoveHorse={moveHorse}
          onDeleteHorse={deleteHorse}
          onAddHorse={addHorse}
          timeAgo={timeAgo}
        />
      )}

      <div style={styles.footnote}>
        Jedes Pferd ist mit einem Code gesperrt, den der Ersteller vergibt – das verhindert
        versehentliches Ändern durch andere. Admin kann alles ohne Code bearbeiten.
      </div>
    </div>
  );
}

function PaddockRow({ paddock, horsesInSlot, filterBucket, onCellClick }) {
  const slots = Array.from({ length: paddock.slot_count }, (_, i) => horsesInSlot[i] || null);
  return (
    <div style={styles.paddockRow}>
      <div style={styles.paddockMeta}>
        <span style={styles.paddockNumber}>{paddock.number}</span>
        {paddock.season && (
          <span style={styles.seasonBadge} title={paddock.season === "S" ? "Sommerweide" : "Winterweide"}>
            {paddock.season}
          </span>
        )}
      </div>
      <div style={styles.slotsWrap}>
        {slots.map((h, i) =>
          h ? (
            <HorseCell key={h.id} horse={h} filterBucket={filterBucket} onClick={() => onCellClick(i, h)} />
          ) : (
            <button key={i} style={styles.emptySlot} onClick={() => onCellClick(i, null)}>
              + Pferd
            </button>
          )
        )}
      </div>
      {paddock.note && <div style={styles.paddockNote}>{paddock.note}</div>}
    </div>
  );
}

function HorseCell({ horse, filterBucket, onClick }) {
  const bucket = bucketOf(horse.status);
  const b = BUCKET[bucket];
  const dimmed = filterBucket && filterBucket !== bucket;
  return (
    <button
      className="cell"
      onClick={onClick}
      style={{
        ...styles.horseCell,
        background: b.bg,
        borderColor: b.border,
        opacity: dimmed ? 0.35 : 1,
      }}
    >
      <div style={styles.horseCellOwner}>{horse.owner}</div>
      <div style={{ ...styles.horseCellName, color: b.text }}>{horse.name}</div>
      {bucket === "halb" && <div style={styles.horseCellStatus}>{STATUS[horse.status].short}</div>}
      <div style={styles.horseCellIcons}>
        <span>🔒</span>
        {horse.comment && <span title={horse.comment}>💬</span>}
      </div>
    </button>
  );
}

function DetailModal({
  selected,
  horses,
  paddocks,
  adminUnlocked,
  unlockedIds,
  setUnlockedIds,
  freeSlotIn,
  onClose,
  onSetStatus,
  onSaveComment,
  onMoveHorse,
  onDeleteHorse,
  onAddHorse,
  timeAgo,
}) {
  const horse = selected.horseId ? horses.find((h) => h.id === selected.horseId) : null;

  const [pinDraft, setPinDraft] = useState("");
  const [pinError, setPinError] = useState(null);
  const [commentDraft, setCommentDraft] = useState(horse?.comment || "");
  const [moveTarget, setMoveTarget] = useState("");

  const [newName, setNewName] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newPin, setNewPin] = useState("");

  const unlocked = adminUnlocked || (horse && unlockedIds.has(horse.id));

  function tryUnlock() {
    if (horse && pinDraft.trim() === horse.pin) {
      setUnlockedIds((prev) => new Set(prev).add(horse.id));
      setPinError(null);
    } else {
      setPinError("Code stimmt nicht.");
    }
  }

  if (!horse && selected.newForPaddock !== undefined) {
    const paddock = paddocks.find((p) => p.id === selected.newForPaddock);
    return (
      <ModalShell onClose={onClose} title={paddock ? `Neues Pferd – Weide ${paddock.number}` : "Neues Pferd"}>
        <label style={styles.modalLabel}>Name des Pferdes</label>
        <input style={styles.modalInput} value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
        <label style={styles.modalLabel}>Besitzer</label>
        <input style={styles.modalInput} value={newOwner} onChange={(e) => setNewOwner(e.target.value)} />
        <label style={styles.modalLabel}>Code (zum späteren Ändern nötig)</label>
        <input style={styles.modalInput} value={newPin} onChange={(e) => setNewPin(e.target.value)} />
        <button
          style={styles.modalPrimaryBtn}
          onClick={() =>
            newName.trim() &&
            newPin.trim() &&
            onAddHorse({
              name: newName.trim(),
              owner: newOwner.trim(),
              pin: newPin.trim(),
              paddockId: selected.newForPaddock,
              slotIndex: selected.slot,
            })
          }
        >
          Eintragen
        </button>
      </ModalShell>
    );
  }

  if (!horse) return null;

  const paddock = paddocks.find((p) => p.id === horse.paddock_id);

  return (
    <ModalShell onClose={onClose} title={horse.name}>
      <div style={styles.modalOwner}>{horse.owner}</div>
      {paddock && <div style={styles.modalPaddockInfo}>Weide {paddock.number}</div>}

      <div style={styles.modalStatusLabel}>
        Status: <strong>{STATUS[horse.status].label}</strong>
      </div>
      <div style={styles.modalTimestamp}>Zuletzt geändert {timeAgo(horse.updated_at)}</div>

      {!unlocked && (
        <div style={styles.lockBox}>
          <div style={styles.lockLabel}>🔒 Gesperrt – Code eingeben, um zu ändern</div>
          <div style={styles.lockRow}>
            <input
              style={styles.pinInput}
              type="password"
              placeholder="Code"
              value={pinDraft}
              onChange={(e) => setPinDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && tryUnlock()}
            />
            <button style={styles.unlockBtn} onClick={tryUnlock}>
              Entsperren
            </button>
          </div>
          {pinError && <div style={styles.pinError}>{pinError}</div>}
        </div>
      )}

      {unlocked && (
        <>
          <label style={styles.modalLabel}>Status ändern</label>
          <div style={styles.statusGrid}>
            {STATUS_ORDER.map((key) => (
              <button
                key={key}
                onClick={() => onSetStatus(horse.id, key)}
                style={{ ...styles.statusBtn, ...(horse.status === key ? styles.statusBtnActive : {}) }}
              >
                {STATUS[key].short}
              </button>
            ))}
          </div>

          <label style={styles.modalLabel}>Weide wechseln</label>
          <div style={styles.moveRow}>
            <select style={styles.modalInput} value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)}>
              <option value="">– Weide wählen –</option>
              {paddocks.map((p) => (
                <option key={p.id} value={p.id} disabled={freeSlotIn(p.id) === null && p.id !== horse.paddock_id}>
                  Weide {p.number} {freeSlotIn(p.id) === null && p.id !== horse.paddock_id ? "(voll)" : ""}
                </option>
              ))}
            </select>
            <button
              style={styles.modalSecondaryBtn}
              onClick={() => {
                if (!moveTarget) return;
                const slot = freeSlotIn(moveTarget);
                if (slot !== null) onMoveHorse(horse.id, moveTarget, slot);
              }}
            >
              Umziehen
            </button>
          </div>

          <label style={styles.modalLabel}>Kommentar (z. B. GM, FD, GL, FB)</label>
          <input
            style={styles.modalInput}
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            onBlur={() => onSaveComment(horse.id, commentDraft.trim())}
            placeholder="Platz für Kommentar, falls nötig"
          />

          <button style={styles.deleteBtn} onClick={() => onDeleteHorse(horse.id)}>
            Pferd entfernen
          </button>
        </>
      )}
    </ModalShell>
  );
}

function ModalShell({ title, onClose, children }) {
  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <h3 style={styles.modalTitle}>{title}</h3>
          <button style={styles.modalCloseBtn} onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AdminPanel({ paddocks, adminPinValue, onReload, setError }) {
  const [newNumber, setNewNumber] = useState("");
  const [newSeason, setNewSeason] = useState("S");
  const [newSlots, setNewSlots] = useState(2);
  const [newAdminPin, setNewAdminPin] = useState(adminPinValue || "");

  async function addPaddock() {
    if (!newNumber.trim()) return;
    const maxOrder = paddocks.reduce((m, p) => Math.max(m, p.order_index), 0);
    const { error: err } = await supabase.from("paddocks").insert({
      number: newNumber.trim(),
      season: newSeason,
      slot_count: Number(newSlots) || 2,
      order_index: maxOrder + 1,
      section: "main",
    });
    if (err) setError("Weide anlegen fehlgeschlagen: " + err.message);
    setNewNumber("");
    onReload();
  }

  async function updatePaddockField(id, field, value) {
    const { error: err } = await supabase.from("paddocks").update({ [field]: value }).eq("id", id);
    if (err) setError("Speichern fehlgeschlagen: " + err.message);
  }

  async function deletePaddock(id) {
    const { error: err } = await supabase.from("paddocks").delete().eq("id", id);
    if (err) setError("Löschen fehlgeschlagen: " + err.message);
    onReload();
  }

  async function saveAdminPin() {
    if (!newAdminPin.trim()) return;
    const { error: err } = await supabase.from("app_settings").update({ admin_pin: newAdminPin.trim() }).eq("id", 1);
    if (err) setError("Admin-Code ändern fehlgeschlagen: " + err.message);
    onReload();
  }

  return (
    <div style={styles.adminPanel}>
      <div style={styles.adminPanelTitle}>Weiden verwalten</div>
      <div style={styles.adminPaddockList}>
        {paddocks.map((p) => (
          <div key={p.id} style={styles.adminPaddockRow}>
            <input
              style={styles.adminMiniInput}
              defaultValue={p.number}
              onBlur={(e) => updatePaddockField(p.id, "number", e.target.value)}
            />
            <select
              style={styles.adminMiniInput}
              defaultValue={p.season || ""}
              onChange={(e) => updatePaddockField(p.id, "season", e.target.value)}
            >
              <option value="S">S</option>
              <option value="W">W</option>
            </select>
            <input
              style={{ ...styles.adminMiniInput, flex: 1 }}
              defaultValue={p.note || ""}
              placeholder="Notiz"
              onBlur={(e) => updatePaddockField(p.id, "note", e.target.value)}
            />
            <button style={styles.adminDeleteBtn} onClick={() => deletePaddock(p.id)}>
              🗑
            </button>
          </div>
        ))}
      </div>
      <div style={styles.adminAddRow}>
        <input
          style={styles.adminMiniInput}
          placeholder="Nr."
          value={newNumber}
          onChange={(e) => setNewNumber(e.target.value)}
        />
        <select style={styles.adminMiniInput} value={newSeason} onChange={(e) => setNewSeason(e.target.value)}>
          <option value="S">S</option>
          <option value="W">W</option>
        </select>
        <input
          style={styles.adminMiniInput}
          type="number"
          min="1"
          max="6"
          value={newSlots}
          onChange={(e) => setNewSlots(e.target.value)}
        />
        <button style={styles.modalSecondaryBtn} onClick={addPaddock}>
          + Weide
        </button>
      </div>

      <div style={styles.adminPanelTitle}>Admin-Code ändern</div>
      <div style={styles.adminAddRow}>
        <input style={styles.adminMiniInput} value={newAdminPin} onChange={(e) => setNewAdminPin(e.target.value)} />
        <button style={styles.modalSecondaryBtn} onClick={saveAdminPin}>
          Speichern
        </button>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#26332A",
    padding: "24px 14px 60px",
    fontFamily: "'IBM Plex Mono', monospace",
    color: "#EFE8D8",
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 4 },
  headerBtns: { display: "flex", gap: 8 },
  eyebrow: { fontSize: 11, letterSpacing: "0.18em", color: "#C9A227", marginBottom: 4 },
  title: {
    fontFamily: "'Fraunces', serif",
    fontWeight: 600,
    fontSize: "clamp(24px, 6vw, 34px)",
    margin: 0,
    color: "#F7F3E8",
  },
  refreshNote: { fontSize: 10.5, color: "#8FAF8A", marginTop: 4 },
  adminBtn: {
    background: "transparent",
    color: "#C9A227",
    border: "1.5px solid #C9A227",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 600,
  },
  adminActiveBtn: {
    background: "#C9A227",
    color: "#26332A",
    border: "none",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 600,
  },
  adminLoginBox: { display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" },
  errorBanner: {
    margin: "14px 0 0",
    background: "#4A2E2E",
    color: "#F2C6C6",
    padding: "10px 14px",
    borderRadius: 6,
    fontSize: 12.5,
  },
  empty: { margin: "30px 0", textAlign: "center", color: "#A9B7A9", fontSize: 13 },
  filterBar: { display: "flex", gap: 6, flexWrap: "wrap", margin: "16px 0" },
  chip: {
    border: "1.5px solid #5C6E5E",
    borderRadius: 999,
    padding: "5px 11px",
    fontSize: 11.5,
    fontWeight: 600,
    background: "transparent",
    color: "#EFE8D8",
  },
  chipActive: { background: "#EFE8D8", color: "#26332A", borderColor: "#EFE8D8" },
  list: { display: "flex", flexDirection: "column", gap: 8 },
  sectionHeading: {
    fontFamily: "'Fraunces', serif",
    fontWeight: 600,
    fontSize: 15,
    color: "#C9A227",
    marginTop: 14,
    marginBottom: 2,
  },
  paddockRow: { background: "#2E3D31", border: "1px solid #3E4F41", borderRadius: 10, padding: "8px 8px 6px" },
  paddockMeta: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6, paddingLeft: 2 },
  paddockNumber: { fontSize: 11, fontWeight: 700, color: "#9CB09E" },
  seasonBadge: { fontSize: 9.5, fontWeight: 700, color: "#26332A", background: "#9CB09E", borderRadius: 4, padding: "1px 5px" },
  paddockNote: { fontSize: 10.5, color: "#D9A05B", marginTop: 6, paddingLeft: 2 },
  slotsWrap: { display: "flex", gap: 6, flexWrap: "wrap" },
  horseCell: {
    flex: "1 1 130px",
    minWidth: 130,
    textAlign: "left",
    border: "1.5px solid",
    borderRadius: 8,
    padding: "8px 9px",
    position: "relative",
  },
  horseCellOwner: { fontSize: 10, color: "#6B675B" },
  horseCellName: { fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 15.5, lineHeight: 1.2 },
  horseCellStatus: { fontSize: 10, fontWeight: 600, marginTop: 2, color: "#8A4E1C" },
  horseCellIcons: { position: "absolute", top: 6, right: 7, fontSize: 10, display: "flex", gap: 4, opacity: 0.6 },
  emptySlot: {
    flex: "1 1 130px",
    minWidth: 130,
    border: "1.5px dashed #4A5D4D",
    borderRadius: 8,
    padding: "8px 9px",
    background: "transparent",
    color: "#7C8C7E",
    fontSize: 12,
  },
  footnote: { textAlign: "center", fontSize: 11, color: "#8A9A8C", marginTop: 26 },

  adminPanel: { background: "#2E3D31", border: "1px solid #3E4F41", borderRadius: 10, padding: 12, marginBottom: 14 },
  adminPanelTitle: { fontFamily: "'Fraunces', serif", fontSize: 15, color: "#F7F3E8", marginBottom: 8, marginTop: 10 },
  adminPaddockList: { display: "flex", flexDirection: "column", gap: 5 },
  adminPaddockRow: { display: "flex", gap: 5, alignItems: "center" },
  adminMiniInput: {
    padding: "5px 7px",
    borderRadius: 5,
    border: "1px solid #4A5D4D",
    background: "#26332A",
    color: "#F7F3E8",
    fontSize: 11.5,
    width: 52,
  },
  adminDeleteBtn: { background: "none", border: "none", color: "#C97A7A", fontSize: 13, padding: 4 },
  adminAddRow: { display: "flex", gap: 6, marginTop: 8, alignItems: "center" },

  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(10, 14, 10, 0.6)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    zIndex: 50,
  },
  modalBox: {
    background: "#F7F3E8",
    color: "#2A2A24",
    width: "100%",
    maxWidth: 480,
    maxHeight: "88vh",
    overflowY: "auto",
    borderRadius: "16px 16px 0 0",
    padding: "18px 20px 28px",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  modalTitle: { fontFamily: "'Fraunces', serif", fontSize: 24, margin: 0 },
  modalCloseBtn: { background: "none", border: "none", fontSize: 24, color: "#8A857A", lineHeight: 1 },
  modalOwner: { fontSize: 13, color: "#7A7568", marginBottom: 10 },
  modalPaddockInfo: { fontSize: 12, color: "#6B8F58", fontWeight: 600, marginBottom: 6 },
  modalStatusLabel: { fontSize: 13, marginBottom: 4 },
  modalTimestamp: { fontSize: 11, color: "#9A9482", marginBottom: 14 },
  modalLabel: { display: "block", fontSize: 11.5, fontWeight: 600, color: "#7A7568", marginTop: 14, marginBottom: 6 },
  modalInput: { width: "100%", padding: "9px 10px", borderRadius: 6, border: "1px solid #DCD4C2", background: "#fff", fontSize: 13 },
  modalPrimaryBtn: {
    marginTop: 18,
    width: "100%",
    background: "#6B8F58",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px",
    fontSize: 14,
    fontWeight: 600,
  },
  modalSecondaryBtn: {
    background: "#26332A",
    color: "#EFE8D8",
    border: "none",
    borderRadius: 6,
    padding: "9px 12px",
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  statusGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  statusBtn: { border: "1.5px solid #C9BFA9", borderRadius: 6, padding: "9px 6px", fontSize: 12, fontWeight: 600, background: "#fff", color: "#4A4638" },
  statusBtnActive: { background: "#26332A", color: "#EFE8D8", borderColor: "#26332A" },
  moveRow: { display: "flex", gap: 6 },
  lockBox: { background: "#EFEAE0", border: "1px dashed #C9BFA9", borderRadius: 8, padding: "12px", marginTop: 14 },
  lockLabel: { fontSize: 12, fontWeight: 600, color: "#7A7568", marginBottom: 8 },
  lockRow: { display: "flex", gap: 6 },
  pinInput: { flex: 1, minWidth: 0, padding: "8px 9px", borderRadius: 6, border: "1px solid #C9BFA9", fontSize: 13, background: "#fff", color: "#2A2A24" },
  unlockBtn: { background: "#26332A", color: "#EFE8D8", border: "none", borderRadius: 6, padding: "8px 12px", fontSize: 12, fontWeight: 600 },
  pinError: { marginTop: 6, fontSize: 11, color: "#B23B3B" },
  deleteBtn: {
    marginTop: 20,
    width: "100%",
    background: "transparent",
    border: "1.5px solid #B23B3B",
    color: "#B23B3B",
    borderRadius: 8,
    padding: "10px",
    fontSize: 12.5,
    fontWeight: 600,
  },
};
