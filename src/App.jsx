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
  voll: { bg: "#B7DFA3", border: "#4F7A3A", text: "#2C4620", label: "Vollservice" },
  halb: { bg: "#F6C98A", border: "#B5651D", text: "#7A431D", label: "Halbservice" },
  kein: { bg: "#D3CFC3", border: "#847E6E", text: "#4F4A3D", label: "Kein Service" },
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
  const [mode, setMode] = useState("weide"); // 'weide' | 'fuehranlage'

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
      setMode(s?.mode || "weide");
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
    const updatedAt = new Date().toISOString();
    setHorses((prev) => prev.map((h) => (h.id === id ? { ...h, status, updated_at: updatedAt } : h)));
    const { error: err } = await supabase.from("horses").update({ status, updated_at: updatedAt }).eq("id", id);
    if (err) setError("Speichern fehlgeschlagen: " + err.message);
  }

  async function setFuehranlageStatus(id, val) {
    setHorses((prev) => prev.map((h) => (h.id === id ? { ...h, fuehranlage_status: val } : h)));
    const { error: err } = await supabase.from("horses").update({ fuehranlage_status: val }).eq("id", id);
    if (err) setError("Speichern fehlgeschlagen: " + err.message);
  }

  async function setFuehranlageActive(id, active) {
    setHorses((prev) => prev.map((h) => (h.id === id ? { ...h, fuehranlage_active: active } : h)));
    const { error: err } = await supabase.from("horses").update({ fuehranlage_active: active }).eq("id", id);
    if (err) setError("Speichern fehlgeschlagen: " + err.message);
    load();
  }

  async function saveComment(id, text) {
    setHorses((prev) => prev.map((h) => (h.id === id ? { ...h, comment: text } : h)));
    const { error: err } = await supabase.from("horses").update({ comment: text }).eq("id", id);
    if (err) setError("Speichern fehlgeschlagen: " + err.message);
  }

  async function moveHorse(id, paddockId, slotIndex) {
    setHorses((prev) =>
      prev.map((h) => (h.id === id ? { ...h, paddock_id: paddockId, slot_index: slotIndex } : h))
    );
    const { error: err } = await supabase
      .from("horses")
      .update({ paddock_id: paddockId, slot_index: slotIndex })
      .eq("id", id);
    if (err) setError("Verschieben fehlgeschlagen: " + err.message);
  }

  async function deleteHorse(id) {
    setHorses((prev) => prev.filter((h) => h.id !== id));
    const { error: err } = await supabase.from("horses").delete().eq("id", id);
    if (err) setError("Entfernen fehlgeschlagen: " + err.message);
    setSelected(null);
    load();
  }

  async function addHorse({ name, owner, pin, paddockId, slotIndex }) {
    const { data, error: err } = await supabase
      .from("horses")
      .insert({
        name,
        owner,
        pin,
        status: "weide_normal",
        comment: "",
        paddock_id: paddockId || null,
        slot_index: slotIndex,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (err) {
      setError("Eintragen fehlgeschlagen: " + err.message);
    } else if (data) {
      setHorses((prev) => [...prev, data]);
    }
    setSelected(null);
    load();
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

  // Gruppiert Weiden zeilenweise (links+rechts mit gleicher order_index),
  // mit Abschnitts-Überschriften wo nötig
  const rows = [];
  {
    const byOrder = {};
    paddocks.forEach((p) => {
      if (!byOrder[p.order_index]) byOrder[p.order_index] = [];
      byOrder[p.order_index].push(p);
    });
    const orderKeys = Object.keys(byOrder)
      .map(Number)
      .sort((a, b) => a - b);
    let lastTitle = null;
    orderKeys.forEach((ord) => {
      const group = byOrder[ord];
      const left = group.find((p) => p.column !== "right") || null;
      const right = group.find((p) => p.column === "right") || null;
      const title = (left && left.section_title) || (right && right.section_title) || null;
      if (title && title !== lastTitle) {
        rows.push({ type: "heading", key: "h-" + ord, title });
        lastTitle = title;
      } else if (!title) {
        lastTitle = null;
      }
      rows.push({ type: "row", key: "row-" + ord, left, right });
    });
  }

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

      {!loading && mode === "weide" && (
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

      {mode === "fuehranlage" && !loading && (
        <div style={styles.modeBanner}>🌀 Führanlagenbetrieb aktiv – Weide-Status bleibt im Hintergrund erhalten</div>
      )}

      {adminUnlocked && showAdminPanel && (
        <AdminPanel
          paddocks={paddocks}
          horses={horses}
          adminPinValue={adminPinValue}
          mode={mode}
          onReload={load}
          setError={setError}
          onAddNewHorse={() => setSelected({ newForPaddock: null, slot: 0 })}
        />
      )}

      {!loading && mode === "weide" && (
        <div style={styles.list}>
          {rows.map((row) =>
            row.type === "heading" ? (
              <div key={row.key} style={styles.sectionHeading}>
                {row.title}
              </div>
            ) : (
              <div key={row.key} style={styles.rowWrap}>
                {row.left ? (
                  <PaddockBox
                    paddock={row.left}
                    horsesInSlot={horsesByPaddock[row.left.id] || {}}
                    filterBucket={filterBucket}
                    onCellClick={(slotIndex, horse) =>
                      setSelected(horse ? { horseId: horse.id } : { newForPaddock: row.left.id, slot: slotIndex })
                    }
                  />
                ) : (
                  <div style={styles.spacerBox} />
                )}
                {row.right ? (
                  <PaddockBox
                    paddock={row.right}
                    horsesInSlot={horsesByPaddock[row.right.id] || {}}
                    filterBucket={filterBucket}
                    onCellClick={(slotIndex, horse) =>
                      setSelected(horse ? { horseId: horse.id } : { newForPaddock: row.right.id, slot: slotIndex })
                    }
                  />
                ) : (
                  <div style={styles.spacerBox} />
                )}
              </div>
            )
          )}

          {unassignedHorses.length > 0 && (
            <>
              <div style={styles.sectionHeading}>Nicht zugeordnet</div>
              <div style={styles.paddockBox}>
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

      {!loading && mode === "fuehranlage" && (
        <FuehranlageView horses={horses} onCellClick={(id) => setSelected({ horseId: id })} onSaveComment={saveComment} />
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
          mode={mode}
          onClose={() => setSelected(null)}
          onSetStatus={setStatus}
          onSetFuehranlage={setFuehranlageStatus}
          onSetFuehranlageActive={setFuehranlageActive}
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

function FuehranlageView({ horses, onCellClick, onSaveComment }) {
  const activeHorses = horses.filter((h) => h.fuehranlage_active !== false);
  const sorted = [...activeHorses].sort((a, b) => {
    const ao = a.fuehranlage_order ?? 9999;
    const bo = b.fuehranlage_order ?? 9999;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name, "de");
  });

  const jaHorses = sorted.filter((h) => h.fuehranlage_status === "ja");
  const neinHorses = sorted.filter((h) => h.fuehranlage_status !== "ja");

  // Feste Vierer-Plätze, immer nachgefüllt: sobald ein Pferd auf "nein"
  // steht, rutscht das nächste Pferd in der Reihenfolge nach.
  const groups = [];
  for (let i = 0; i < jaHorses.length; i += 4) {
    groups.push(jaHorses.slice(i, i + 4));
  }

  return (
    <>
      <div style={styles.filterBar}>
        <span style={{ ...styles.chip, borderColor: "#4F7A3A", color: "#B7DFA3" }}>Ja · {jaHorses.length}</span>
        <span style={{ ...styles.chip, borderColor: "#A5453D", color: "#E9B9B4" }}>
          Nein · {neinHorses.length}
        </span>
      </div>

      <div style={styles.list}>
        {groups.length === 0 && (
          <div style={styles.empty}>Noch keine Pferde für die Führanlage ausgewählt.</div>
        )}
        {groups.map((group, gi) => (
          <div key={gi} style={styles.paddockBox}>
            <div style={styles.slotsWrap}>
              {group.map((h) => (
                <FuehranlageCell key={h.id} horse={h} onClick={() => onCellClick(h.id)} onSaveComment={onSaveComment} />
              ))}
            </div>
          </div>
        ))}

        {neinHorses.length > 0 && (
          <>
            <div style={styles.sectionHeading}>Führanlage nein</div>
            <div style={styles.paddockBox}>
              <div style={styles.slotsWrap}>
                {neinHorses.map((h) => (
                  <FuehranlageCell key={h.id} horse={h} onClick={() => onCellClick(h.id)} onSaveComment={onSaveComment} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function FuehranlageCell({ horse, onClick, onSaveComment }) {
  const ja = horse.fuehranlage_status === "ja";
  const border = ja ? "#4F7A3A" : "#A5453D";
  const textColor = ja ? "#2C4620" : "#6E241E";
  return (
    <div style={{ ...styles.fuehranlageCell, background: ja ? "#B7DFA3" : "#E9B9B4", borderColor: border }}>
      <button className="cell" onClick={onClick} style={styles.fuehranlageClickArea}>
        <div style={styles.lockCornerSmall}>🔒</div>
        <div style={styles.fuehranlageRow}>
          <span style={{ ...styles.fuehranlageName, color: textColor }}>{horse.name}</span>
          <span style={styles.fuehranlageOwner}>{horse.owner}</span>
        </div>
        <div style={{ ...styles.fuehranlageStatusSmall, color: textColor }}>
          {ja ? "Führanlage ja" : "Führanlage nein"}
        </div>
      </button>
      <input
        style={styles.inlineCommentInputSmall}
        defaultValue={horse.comment || ""}
        placeholder="Kommentar, z. B. Gamaschen"
        onBlur={(e) => onSaveComment(horse.id, e.target.value.trim())}
      />
    </div>
  );
}

function PaddockBox({ paddock, horsesInSlot, filterBucket, onCellClick }) {
  const slots = Array.from({ length: paddock.slot_count }, (_, i) => horsesInSlot[i] || null);
  return (
    <div style={styles.paddockBox}>
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
      <div style={styles.lockCorner}>🔒</div>
      <div style={styles.horseCellOwner}>{horse.owner}</div>
      <div style={{ ...styles.horseCellName, color: b.text }}>{horse.name}</div>
      {bucket === "halb" && <div style={styles.horseCellStatus}>{STATUS[horse.status].short}</div>}
      {horse.comment && <div style={styles.horseCellComment}>{horse.comment}</div>}
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
  mode,
  onClose,
  onSetStatus,
  onSetFuehranlage,
  onSetFuehranlageActive,
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
        {mode === "fuehranlage" ? (
          <>
            Führanlage: <strong>{horse.fuehranlage_status === "ja" ? "Ja" : "Nein"}</strong>
          </>
        ) : (
          <>
            Status: <strong>{STATUS[horse.status].label}</strong>
          </>
        )}
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
          {mode === "fuehranlage" ? (
            <>
              <label style={styles.modalLabel}>Führanlage</label>
              <div style={styles.statusGrid}>
                <button
                  onClick={() => onSetFuehranlage(horse.id, "ja")}
                  style={{
                    ...styles.statusBtn,
                    ...(horse.fuehranlage_status === "ja"
                      ? { background: "#4F7A3A", color: "#fff", borderColor: "#4F7A3A" }
                      : {}),
                  }}
                >
                  Führanlage ja
                </button>
                <button
                  onClick={() => onSetFuehranlage(horse.id, "nein")}
                  style={{
                    ...styles.statusBtn,
                    ...(horse.fuehranlage_status !== "ja"
                      ? { background: "#A5453D", color: "#fff", borderColor: "#A5453D" }
                      : {}),
                  }}
                >
                  Führanlage nein
                </button>
              </div>
              <div style={styles.modalTimestamp}>
                Weide-Status bleibt im Hintergrund erhalten ({STATUS[horse.status].label}).
              </div>
            </>
          ) : (
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
            </>
          )}

          <label style={styles.modalLabel}>Kommentar (z. B. GM, FD, GL, FB)</label>
          <input
            style={styles.modalInput}
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            onBlur={() => onSaveComment(horse.id, commentDraft.trim())}
            placeholder="Platz für Kommentar, falls nötig"
          />

          {mode === "fuehranlage" ? (
            <button
              style={styles.deleteBtn}
              onClick={() => {
                onSetFuehranlageActive(horse.id, false);
                onClose();
              }}
            >
              Aus Führanlagen-Liste entfernen
            </button>
          ) : (
            <button style={styles.deleteBtn} onClick={() => onDeleteHorse(horse.id)}>
              Pferd entfernen
            </button>
          )}
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

function AdminPanel({ paddocks, horses, adminPinValue, mode, onReload, setError, onAddNewHorse }) {
  const [newNumber, setNewNumber] = useState("");
  const [newSeason, setNewSeason] = useState("S");
  const [newSlots, setNewSlots] = useState(2);
  const [newColumn, setNewColumn] = useState("left");
  const [newAdminPin, setNewAdminPin] = useState(adminPinValue || "");

  async function setGlobalMode(newMode) {
    const { error: err } = await supabase.from("app_settings").update({ mode: newMode }).eq("id", 1);
    if (err) setError("Modus ändern fehlgeschlagen: " + err.message);
    onReload();
  }

  const activeForOrder = horses.filter((h) => h.fuehranlage_active !== false);
  const inactiveForOrder = horses.filter((h) => h.fuehranlage_active === false);

  const sortedForOrder = [...activeForOrder].sort((a, b) => {
    const ao = a.fuehranlage_order ?? 9999;
    const bo = b.fuehranlage_order ?? 9999;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name, "de");
  });

  // Verschiebt ein Pferd direkt an eine Zielposition; alle anderen rutschen
  // automatisch sauber nach (statt nur Tausch mit dem Nachbarn).
  async function moveToPosition(horseId, targetPosition) {
    const moving = sortedForOrder.find((h) => h.id === horseId);
    if (!moving) return;
    const rest = sortedForOrder.filter((h) => h.id !== horseId);
    let idx = Math.round(targetPosition) - 1;
    idx = Math.max(0, Math.min(idx, rest.length));
    rest.splice(idx, 0, moving);
    const { error: err } = await (async () => {
      for (let i = 0; i < rest.length; i++) {
        const { error } = await supabase.from("horses").update({ fuehranlage_order: i + 1 }).eq("id", rest[i].id);
        if (error) return { error };
      }
      return { error: null };
    })();
    if (err) setError("Verschieben fehlgeschlagen: " + err.message);
    onReload();
  }

  async function setFuehranlageActive(id, active) {
    const { error: err } = await supabase.from("horses").update({ fuehranlage_active: active }).eq("id", id);
    if (err) setError("Speichern fehlgeschlagen: " + err.message);
    onReload();
  }

  async function addPaddock() {
    if (!newNumber.trim()) return;
    const maxOrder = paddocks.reduce((m, p) => Math.max(m, p.order_index), 0);
    const { error: err } = await supabase.from("paddocks").insert({
      number: newNumber.trim(),
      season: newSeason,
      slot_count: Number(newSlots) || 2,
      order_index: maxOrder + 1,
      section: "main",
      column: newColumn,
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
      <div style={styles.adminPanelTitle}>Betriebsmodus</div>
      <div style={styles.adminAddRow}>
        <button
          style={mode === "weide" ? styles.modeBtnActive : styles.modeBtn}
          onClick={() => setGlobalMode("weide")}
        >
          🌿 Weidebetrieb
        </button>
        <button
          style={mode === "fuehranlage" ? styles.modeBtnActive : styles.modeBtn}
          onClick={() => setGlobalMode("fuehranlage")}
        >
          🌀 Führanlagenbetrieb
        </button>
      </div>
      <div style={styles.adminHint}>Gilt sofort für alle – bei Regen einfach umschalten.</div>

      <div style={styles.adminPanelTitle}>Führanlagen-Reihenfolge</div>
      <div style={styles.adminHint}>
        Zahl = Zielposition (Enter zum Bestätigen) – die Liste rutscht automatisch nach. Nach jeweils 4
        Pferden eine Trennlinie (= eine Runde).
      </div>
      <button style={{ ...styles.modalSecondaryBtn, marginBottom: 8 }} onClick={onAddNewHorse}>
        + Neues Pferd eintragen
      </button>
      <div style={styles.adminPaddockList}>
        {sortedForOrder.map((h, i) => (
          <div key={h.id}>
            <div style={styles.adminOrderRow}>
              <input
                key={h.id + "-" + i}
                style={styles.orderNumberInput}
                type="number"
                defaultValue={i + 1}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.target.blur();
                }}
                onBlur={(e) => {
                  const val = Number(e.target.value);
                  if (val && val !== i + 1) moveToPosition(h.id, val);
                }}
              />
              <div style={styles.orderArrows}>
                <button
                  style={{ ...styles.arrowBtnBig, opacity: i === 0 ? 0.35 : 1 }}
                  onClick={() => moveToPosition(h.id, i)}
                  disabled={i === 0}
                >
                  ▲
                </button>
                <button
                  style={{ ...styles.arrowBtnBig, opacity: i === sortedForOrder.length - 1 ? 0.35 : 1 }}
                  onClick={() => moveToPosition(h.id, i + 2)}
                  disabled={i === sortedForOrder.length - 1}
                >
                  ▼
                </button>
              </div>
              <span style={styles.adminOrderLabel}>
                {h.name} ({h.owner})
              </span>
              <button style={styles.adminDeleteBtn} title="Aus Führanlagen-Liste entfernen" onClick={() => setFuehranlageActive(h.id, false)}>
                ✕
              </button>
            </div>
            {(i + 1) % 4 === 0 && i !== sortedForOrder.length - 1 && <div style={styles.orderDivider} />}
          </div>
        ))}
      </div>

      {inactiveForOrder.length > 0 && (
        <>
          <div style={styles.adminPanelTitle}>Nicht in der Führanlagen-Liste</div>
          <div style={styles.adminPaddockList}>
            {inactiveForOrder.map((h) => (
              <div key={h.id} style={styles.adminOrderRow}>
                <span style={styles.adminOrderLabel}>
                  {h.name} ({h.owner})
                </span>
                <button style={styles.modalSecondaryBtn} onClick={() => setFuehranlageActive(h.id, true)}>
                  + Wieder aufnehmen
                </button>
              </div>
            ))}
          </div>
        </>
      )}

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
            <select
              style={styles.adminMiniInput}
              defaultValue={p.column || "left"}
              onChange={(e) => updatePaddockField(p.id, "column", e.target.value)}
            >
              <option value="left">links</option>
              <option value="right">rechts</option>
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
        <select style={styles.adminMiniInput} value={newColumn} onChange={(e) => setNewColumn(e.target.value)}>
          <option value="left">links</option>
          <option value="right">rechts</option>
        </select>
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
  modeBanner: {
    margin: "12px 0",
    padding: "9px 12px",
    background: "#3A3F26",
    border: "1px solid #6B6E3E",
    borderRadius: 8,
    fontSize: 12,
    color: "#E5DFC0",
  },
  modeBtn: {
    background: "transparent",
    border: "1.5px solid #5C6E5E",
    color: "#EFE8D8",
    borderRadius: 6,
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 600,
  },
  modeBtnActive: {
    background: "#C9A227",
    border: "1.5px solid #C9A227",
    color: "#26332A",
    borderRadius: 6,
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 600,
  },
  adminHint: { fontSize: 10.5, color: "#9CB09E", marginTop: 4, marginBottom: 4 },
  list: { display: "flex", flexDirection: "column", gap: 10 },
  rowWrap: { display: "flex", gap: 14, alignItems: "flex-start" },
  spacerBox: { flex: 1, minWidth: 0 },
  sectionHeading: {
    fontFamily: "'Fraunces', serif",
    fontWeight: 600,
    fontSize: 15,
    color: "#C9A227",
    marginTop: 14,
    marginBottom: 2,
  },
  paddockBox: { flex: 1, minWidth: 0, background: "#2E3D31", border: "1px solid #3E4F41", borderRadius: 10, padding: "8px 8px 6px" },
  paddockMeta: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6, paddingLeft: 2 },
  paddockNumber: { fontSize: 16, fontWeight: 800, color: "#EFE8D8" },
  seasonBadge: { fontSize: 9.5, fontWeight: 700, color: "#26332A", background: "#9CB09E", borderRadius: 4, padding: "1px 5px" },
  paddockNote: { fontSize: 10.5, color: "#D9A05B", marginTop: 6, paddingLeft: 2 },
  slotsWrap: { display: "flex", flexDirection: "column", gap: 6 },
  horseCell: {
    width: "100%",
    textAlign: "left",
    border: "1.5px solid",
    borderRadius: 8,
    padding: "8px 9px",
    position: "relative",
  },
  horseCellOwner: { fontSize: 10, color: "#6B675B" },
  horseCellName: { fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 15.5, lineHeight: 1.2 },
  horseCellStatus: { fontSize: 10, fontWeight: 600, marginTop: 2, color: "#8A4E1C" },
  horseCellComment: {
    fontSize: 10.5,
    marginTop: 5,
    padding: "2px 6px",
    background: "rgba(255,255,255,0.55)",
    borderRadius: 4,
    color: "#B23B3B",
    fontWeight: 600,
    display: "inline-block",
    wordBreak: "break-word",
  },
  lockCorner: { position: "absolute", top: 6, right: 7, fontSize: 10, opacity: 0.55 },
  fuehranlageClickArea: {
    width: "100%",
    textAlign: "left",
    background: "transparent",
    border: "none",
    padding: 0,
    position: "relative",
    display: "block",
  },
  inlineCommentInput: {
    width: "100%",
    marginTop: 7,
    padding: "6px 8px",
    borderRadius: 5,
    border: "1px solid rgba(0,0,0,0.15)",
    background: "rgba(255,255,255,0.65)",
    fontSize: 11,
    color: "#3A362C",
  },
  fuehranlageCell: {
    width: "100%",
    border: "1.5px solid",
    borderRadius: 7,
    padding: "6px 8px",
    position: "relative",
  },
  fuehranlageRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6, paddingRight: 16 },
  fuehranlageName: { fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 13.5 },
  fuehranlageOwner: { fontSize: 9.5, color: "#4A4638" },
  fuehranlageStatusSmall: { fontSize: 9, fontWeight: 600, marginTop: 1 },
  lockCornerSmall: { position: "absolute", top: 5, right: 6, fontSize: 9, opacity: 0.5 },
  inlineCommentInputSmall: {
    width: "100%",
    marginTop: 4,
    padding: "4px 6px",
    borderRadius: 4,
    border: "1px solid rgba(0,0,0,0.15)",
    background: "rgba(255,255,255,0.65)",
    fontSize: 10,
    color: "#3A362C",
  },
  emptySlot: {
    width: "100%",
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
  adminOrderRow: { display: "flex", gap: 8, alignItems: "center", padding: "4px 0" },
  orderNumberInput: {
    width: 40,
    padding: "6px 4px",
    borderRadius: 5,
    border: "1px solid #4A5D4D",
    background: "#26332A",
    color: "#F7F3E8",
    fontSize: 12,
    textAlign: "center",
  },
  orderArrows: { display: "flex", flexDirection: "column", gap: 3 },
  arrowBtn: {
    background: "#26332A",
    color: "#EFE8D8",
    border: "1px solid #4A5D4D",
    borderRadius: 4,
    width: 22,
    height: 18,
    fontSize: 10,
    lineHeight: 1,
    padding: 0,
  },
  arrowBtnBig: {
    background: "#26332A",
    color: "#EFE8D8",
    border: "1px solid #4A5D4D",
    borderRadius: 5,
    width: 34,
    height: 28,
    fontSize: 14,
    lineHeight: 1,
    padding: 0,
  },
  adminOrderLabel: { fontSize: 12, flex: 1 },
  orderDivider: { borderTop: "1px dashed #4A5D4D", margin: "6px 0" },

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
