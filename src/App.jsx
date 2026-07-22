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
            <button key={i} style={styles.emptySlot} onClick={() => onCellClick
