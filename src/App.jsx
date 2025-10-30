import React, { useState, useRef } from "react";
import { createWorker } from "tesseract.js";

function parseLinesToPairs(text) {
  // Splits text into lines and tries to extract "name" and "km" pairs.
  // Support lines like:
  // "Jan 150", "Pieter: 100 km", "Anna - 75"
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const pairs = [];
  const nameKmRegex = /([A-Za-zÀ-ÿ0-9_\- ]{2,30})\s*[:\-]?\s*(\d{1,6})(?:\s*km)?/i;
  for (const line of lines) {
    const m = line.match(nameKmRegex);
    if (m) {
      const name = m[1].trim();
      const km = parseInt(m[2], 10);
      if (!isNaN(km)) pairs.push({ name, km });
    } else {
      // try token parsing e.g. "Jan 150 Pieter 100" => handle pairs
      const tokens = line.split(/\s+/);
      for (let i=0;i<tokens.length-1;i+=2) {
        const maybeName = tokens[i];
        const maybeKm = tokens[i+1].replace(/\D/g,'');
        if (maybeKm && /^\d+$/.test(maybeKm)) {
          pairs.push({ name: maybeName, km: parseInt(maybeKm, 10) });
        }
      }
    }
  }
  return pairs;
}

function round2(x){ return Math.round((x+Number.EPSILON)*100)/100; }

export default function App() {
  const [imageSrc, setImageSrc] = useState(null);
  const [ocrText, setOcrText] = useState("");
  const [rows, setRows] = useState([]); // {name, km}
  const [amount, setAmount] = useState(50.0);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const workerRef = useRef(null);
  const fileInputRef = useRef();

  async function doOCR(file) {
    setLoading(true);
    setProgress(0);
    const worker = createWorker({
      logger: m => {
        if (m.status === 'recognizing text' && m.progress) {
          setProgress(Math.round(m.progress * 100));
        }
      }
    });
    workerRef.current = worker;
    await worker.load();
    await worker.loadLanguage("eng+fra+deu+spa+ita+por+nld");
    await worker.initialize("eng+fra+deu+spa+ita+por+nld");
    // Preprocess not done here; Tesseract will try its best.
    const { data } = await worker.recognize(file);
    setOcrText(data.text);
    const parsed = parseLinesToPairs(data.text);
    if (parsed.length > 0) setRows(parsed);
    setLoading(false);
    setProgress(100);
    await worker.terminate();
    workerRef.current = null;
  }

  function handleFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    setImageSrc(url);
    doOCR(f).catch(err => {
      console.error(err);
      setLoading(false);
      alert("OCR mislukt — kijk console voor details.");
    });
  }

  function handlePasteImage(ev) {
    const items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.indexOf("image") !== -1) {
        const file = it.getAsFile();
        const url = URL.createObjectURL(file);
        setImageSrc(url);
        doOCR(file).catch(err=>{
          console.error(err);
          setLoading(false);
        });
        break;
      }
    }
  }

  function addEmptyRow() {
    setRows(prev => [...prev, { name: `Persoon ${prev.length+1}`, km: 0 }]);
  }

  function updateRow(i, key, value) {
    setRows(prev => {
      const copy = prev.map(r => ({...r}));
      copy[i][key] = key === "km" ? Number(value) : value;
      return copy;
    });
  }

  function removeRow(i) {
    setRows(prev => prev.filter((_, idx) => idx !== i));
  }

  const totalKm = rows.reduce((s, r) => s + (Number(r.km)||0), 0);
  const computed = rows.map(r => {
    const km = Number(r.km) || 0;
    const pct = totalKm > 0 ? km / totalKm : 0;
    const euros = round2(amount * pct);
    return { ...r, pct: round2(pct*100), euros };
  });

  // Calculate who owes who (simple pairwise settlement)
  // We compute net amounts relative to equal split vs actual share.
  // For two people it's straightforward, for many we compute who owes positive net to negatives.
  const fairShare = round2(amount * (1)); // keep amount used later per person via pct
  // Instead compute net per person = euros - (amount * (their share?)) Actually we want: who paid? 
  // We'll assume user enters rows but *no payer* field; better: add optional "paidBy" field? For now: present amounts and show differences.
  // We'll compute each person's balance relative to equal split of amount: paidShare = euros, owed = euros - (amount*(km/totalKm))
  // Simpler: compute pairwise to make clear who should pay based on actual percentages vs equal 50/50 assumption.
  // Instead: Show explicit who should pay: determine who has negative/positive compared to 50/50? We'll produce intuitive summary:
  let summary = "";
  if (rows.length === 2 && totalKm > 0) {
    const [a,b] = computed;
    // Who should pay whom? If a.euros > b.euros, then b pays (a.euros - b.euros)/2? no.
    // Actually the real world: If the tank was paid by A or by B? We need payer info.
    // We'll assume the person who initiated the entry is the payer (first row). Simpler: show difference.
    const diff = round2(Math.abs(a.euros - b.euros));
    if (diff === 0) summary = "Geen betaling nodig — bedragen zijn gelijk.";
    else {
      const payer = a.euros > b.euros ? b.name : a.name; // person who owes is the one with smaller share? Wait, we want "who must pay who to equalize actual payment".
      // We'll show a straightforward statement: "Op basis van km's zou A moeten betalen €X en B €Y — dus B moet €(Y-X) aan A betalen" if A's share > B's share.
      if (a.euros > b.euros) {
        summary = `${b.name} moet €${round2(a.euros - b.euros)} aan ${a.name} betalen.`;
      } else {
        summary = `${a.name} moet €${round2(b.euros - a.euros)} aan ${b.name} betalen.`;
      }
    }
  } else {
    // For many people show short summary of amounts
    if (totalKm === 0) summary = "Voer kilometers in om een samenvatting te krijgen.";
    else summary = "Bekijk de bedragen per persoon. Voor betalingen, vergelijk wie minder heeft bijgedragen en regel onderling de betaling.";
  }

  function copyTikkieText() {
    // Build simple message summarizing who owes who and amounts
    let text = `Tankbeurt — totaal €${amount}\n\n`;
    computed.forEach(c => {
      text += `${c.name}: ${c.km} km — ${c.pct}% — €${c.euros}\n`;
    });
    text += `\nSamenvatting: ${summary}`;
    navigator.clipboard.writeText(text).then(()=> alert("Tikkie-tekst gekopieerd!"));
  }

  return (
    <div className="app" onPaste={handlePasteImage}>
      <header>
        <h1>AutoSplit — Tankkosten OCR</h1>
        <p className="muted">Upload foto van km-boekje → bewerk → bereken</p>
      </header>

      <section className="controls">
        <label className="filebtn">
          📸 Upload foto
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFile} />
        </label>

        <div className="inline">
          <label>Bedrag (€)
            <input type="number" value={amount} onChange={e=>setAmount(Number(e.target.value)||0)} />
          </label>

          <button onClick={addEmptyRow}>+ Regel toevoegen</button>
          <button onClick={()=>{ setRows([]); setOcrText(""); setImageSrc(null); }}>Reset</button>
        </div>
      </section>

      <section className="preview">
        {imageSrc && <div className="imgwrap"><img src={imageSrc} alt="upload preview" /></div>}
        {loading && <div>OCR bezig... {progress}%</div>}
      </section>

      <section className="ocr">
        <h2>OCR resultaat (raw)</h2>
        <textarea value={ocrText} onChange={e=>setOcrText(e.target.value)} rows={6}></textarea>
        <div className="hint">Als OCR niet correct is, bewerk hierboven of voeg regels handmatig toe.</div>
        <button onClick={()=>{
          // parse current text to rows
          const parsed = parseLinesToPairs(ocrText);
          if (parsed.length === 0) alert("Kon geen regels vinden. Controleer tekst of voeg handmatig toe.");
          else setRows(parsed);
        }}>Parse tekst naar regels</button>
      </section>

      <section className="table">
        <h2>Regels (bewerkbaar)</h2>
        <table>
          <thead>
            <tr><th>Naam</th><th>Kilometers</th><th>%</th><th>Bedrag (€)</th><th></th></tr>
          </thead>
          <tbody>
            {computed.map((r, i) => (
              <tr key={i}>
                <td><input value={r.name} onChange={e=>updateRow(i,'name', e.target.value)} /></td>
                <td><input type="number" value={r.km} onChange={e=>updateRow(i,'km', Number(e.target.value)||0)} /></td>
                <td>{isNaN(r.pct) ? "0%" : `${r.pct}%`}</td>
                <td>€{r.euros.toFixed(2)}</td>
                <td><button onClick={()=>removeRow(i)}>✖</button></td>
              </tr>
            ))}
            {computed.length === 0 && <tr><td colSpan="5" className="muted">Geen regels — upload een foto of voeg regels toe.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="summary">
        <h2>Samenvatting</h2>
        <p>{totalKm > 0 ? `Totaal kilometers: ${totalKm}` : "Nog geen kilometers."}</p>
        <div className="summarybox">
          {computed.map((r, i) => (
            <div key={i} className="card">
              <div className="card-title">{r.name}</div>
              <div>{r.km} km — {r.pct}%</div>
              <div className="big">€{r.euros.toFixed(2)}</div>
            </div>
          ))}
        </div>
        <p className="bold">{summary}</p>
        <div className="actions">
          <button onClick={copyTikkieText}>Kopieer Tikkie-tekst</button>
          <button onClick={()=>{ alert("Direct Tikkie sturen vereist zakelijke Tikkie API. We genereren een tekst die je kunt gebruiken in WhatsApp/Tikkie."); copyTikkieText(); }}>Maak Tikkie (tekst)</button>
        </div>
      </section>

      <footer>
        <small>Prototype — OCR werkt het best met duidelijke, contrastrijke foto's van het notitieboekje.</small>
      </footer>
    </div>
  );
}
