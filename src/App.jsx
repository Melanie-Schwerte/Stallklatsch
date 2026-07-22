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
  const sorted = [...horses].sort((a, b) => {
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

  const sortedForOrder = [...horses].sort((a, b) => {
    const ao = a.fuehranlage_order ?? 9999;
    const bo = b.fuehranlage_order ?? 9999;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name, "de");
  });

  async function updateHorseOrder(id, value) {
    const num = value.trim() === "" ? null : Number(value);
    const { error: err } = await supabase.from("horses").update({ fuehranlage_order: num }).eq("id", id);
    if (err) setError("Speichern fehlgeschlagen: " + err.message);
    onReload();
  }

  async function swapOrder(index, direction) {
    const otherIndex = index + direction;
    if (otherIndex < 0 || otherIndex >= sortedForOrder.length) return;
    const a = sortedForOrder[index];
    const b = sortedForOrder[otherIndex];
    const aOrder = a.fuehranlage_order ?? index + 1;
    const bOrder = b.fuehranlage_order ?? otherIndex + 1;
    const { error: err1 } = await supabase.from("horses").update({ fuehranlage_order: bOrder }).eq("id", a.id);
    const { error: err2 } = await supabase.from("horses").update({ fuehranlage_order: aOrder }).eq("id", b.id);
    if (err1 || err2) setError("Verschieben fehlgeschlagen: " + (err1?.message || err2?.message));
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
          onClick={() =
