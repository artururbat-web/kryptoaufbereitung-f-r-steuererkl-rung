(function (global) {
  "use strict";

  const MONEY_DIGITS = 2;
  const QUANTITY_DIGITS = 8;
  const BITVAVO_HEADERS = new Set([
    "Timezone",
    "Date",
    "Time",
    "Type",
    "Currency",
    "Amount",
    "Quote Currency",
    "Quote Price",
    "Received / Paid Currency",
    "Received / Paid Amount",
    "Fee currency",
    "Fee amount",
    "Status",
    "Transaction ID",
  ]);
  const BITVAVO_FINAL_STATUSES = new Set(["completed", "distributed"]);

  function decimal(value) {
    if (value === undefined || value === null || String(value).trim() === "") return 0;
    const parsed = Number(String(value).trim().replace(",", "."));
    if (!Number.isFinite(parsed)) throw new Error(`Ungültige Zahl: ${value}`);
    return parsed;
  }

  function money(value) {
    return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(MONEY_DIGITS);
  }

  function germanMoney(value) {
    return value.replace(".", ",");
  }

  function quantity(value) {
    return Number(value.toFixed(QUANTITY_DIGITS)).toString();
  }

  function detectDelimiter(text) {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    const delimiters = ["\t", ";", ","];
    return delimiters
      .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length - 1 }))
      .sort((left, right) => right.count - left.count)[0].delimiter;
  }

  function parseDelimited(text) {
    const delimiter = detectDelimiter(text);
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (quoted) {
        if (char === '"' && next === '"') {
          field += '"';
          index += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          field += char;
        }
        continue;
      }

      if (char === '"') {
        quoted = true;
      } else if (char === delimiter) {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field);
        if (row.some((cell) => cell.trim() !== "")) rows.push(row);
        row = [];
        field = "";
      } else if (char !== "\r") {
        field += char;
      }
    }
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);

    const headers = rows.shift()?.map((header) => header.replace(/^\uFEFF/, "")) ?? [];
    return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }

  function hasBitvavoHeaders(rows) {
    if (rows.length === 0) return false;
    const headers = Object.keys(rows[0]);
    return [...BITVAVO_HEADERS].every((header) => headers.includes(header));
  }

  function parseDateInZone(date, time, timeZone) {
    const localIso = `${date}T${time}`;
    if (!timeZone || timeZone === "UTC") return new Date(`${localIso}Z`);

    // Browser-compatible conversion for Bitvavo's Europe/Berlin timestamps.
    // Offset changes are derived from the target date by comparing UTC noon.
    if (timeZone !== "Europe/Berlin") {
      throw new Error(`Zeitzone ${timeZone} wird in der Web-App noch nicht unterstützt.`);
    }
    const [year, month, day] = date.split("-").map(Number);
    const utcNoon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      timeZoneName: "shortOffset",
      hour: "2-digit",
    }).formatToParts(utcNoon);
    const offsetPart = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+0";
    const match = offsetPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    const sign = match?.[1] === "-" ? -1 : 1;
    const hours = Number(match?.[2] ?? 0);
    const minutes = Number(match?.[3] ?? 0);
    const offsetMs = sign * (hours * 60 + minutes) * 60_000;
    const [hour, minute, secondRaw = "0"] = time.split(":");
    const second = Math.trunc(Number(secondRaw));
    const millis = Math.round((Number(secondRaw) - second) * 1000);
    return new Date(Date.UTC(year, month - 1, day, Number(hour), Number(minute), second, millis) - offsetMs);
  }

  function bitvavoNote(row) {
    return ["Bitvavo", row.Status ? `status=${row.Status}` : "", row.Address ? `address=${row.Address}` : ""]
      .filter(Boolean)
      .join("; ");
  }

  function transactionFromBitvavo(row, rowNumber) {
    const status = String(row.Status ?? "").trim().toLowerCase();
    if (status && !BITVAVO_FINAL_STATUSES.has(status)) return null;

    const typeMap = {
      buy: "BUY",
      sell: "SELL",
      staking: "INCOME",
      fixed_staking: "INCOME",
      rebate: "INCOME",
      deposit: "TRANSFER_IN",
      withdrawal: "TRANSFER_OUT",
      withdraw: "TRANSFER_OUT",
    };
    const originalType = String(row.Type ?? "").trim().toLowerCase();
    const type = typeMap[originalType];
    if (!type) throw new Error(`Zeile ${rowNumber}: Bitvavo-Typ ${originalType} wird noch nicht unterstützt.`);

    const amount = Math.abs(decimal(row.Amount));
    if (amount <= 0) throw new Error(`Zeile ${rowNumber}: Amount darf nicht 0 sein.`);
    let unitPriceEur = 0;
    if (String(row["Quote Currency"] ?? "").trim().toUpperCase() === "EUR") {
      unitPriceEur = decimal(row["Quote Price"]);
    } else if (["BUY", "SELL"].includes(type)) {
      const receivedPaidCurrency = String(row["Received / Paid Currency"] ?? "").trim().toUpperCase();
      const receivedPaidAmount = decimal(row["Received / Paid Amount"]);
      if (receivedPaidCurrency !== "EUR" || receivedPaidAmount === 0) {
        throw new Error(`Zeile ${rowNumber}: EUR-Kursdaten fehlen.`);
      }
      unitPriceEur = Math.abs(receivedPaidAmount) / amount;
    }

    const feeCurrency = String(row["Fee currency"] ?? "").trim().toUpperCase();
    if (feeCurrency && feeCurrency !== "EUR") throw new Error(`Zeile ${rowNumber}: Gebührenwährung ${feeCurrency} ist noch nicht unterstützt.`);

    return {
      date: parseDateInZone(row.Date, row.Time, row.Timezone || "UTC"),
      type,
      asset: String(row.Currency ?? "").trim().toUpperCase(),
      quantity: amount,
      unitPriceEur,
      feeEur: Math.abs(decimal(row["Fee amount"])),
      txId: String(row["Transaction ID"] || `bitvavo-row-${rowNumber}`).trim(),
      note: bitvavoNote(row),
    };
  }

  function transactionFromNormalized(row, rowNumber) {
    const dateText = String(row.date ?? "").trim();
    const date = new Date(dateText.endsWith("Z") || dateText.includes("+") ? dateText : `${dateText}Z`);
    if (Number.isNaN(date.getTime())) throw new Error(`Zeile ${rowNumber}: Ungültiges Datum ${dateText}`);
    return {
      date,
      type: String(row.type ?? "").trim().toUpperCase(),
      asset: String(row.asset ?? "").trim().toUpperCase(),
      quantity: decimal(row.quantity),
      unitPriceEur: decimal(row.unit_price_eur),
      feeEur: decimal(row.fee_eur),
      txId: String(row.tx_id || `row-${rowNumber}`).trim(),
      note: String(row.note ?? "").trim(),
    };
  }

  function readTransactions(text, source = "auto") {
    const rows = parseDelimited(text);
    const selectedSource = source === "auto" ? (hasBitvavoHeaders(rows) ? "bitvavo" : "normalized") : source;
    const transactions = rows
      .map((row, index) => selectedSource === "bitvavo" ? transactionFromBitvavo(row, index + 2) : transactionFromNormalized(row, index + 2))
      .filter(Boolean)
      .sort((left, right) => left.date - right.date || left.txId.localeCompare(right.txId));
    return transactions;
  }

  function processTransactions(transactions, holdingPeriodDays = 365) {
    const lotsByAsset = new Map();
    const realizedGains = [];
    const income = [];
    const fees = [];

    for (const tx of transactions) {
      if (!lotsByAsset.has(tx.asset)) lotsByAsset.set(tx.asset, []);
      const lots = lotsByAsset.get(tx.asset);
      const grossValue = tx.quantity * tx.unitPriceEur;

      if (tx.feeEur) fees.push({ date: tx.date.toISOString(), asset: tx.asset, type: tx.type, fee_eur: money(tx.feeEur), tx_id: tx.txId, note: tx.note });

      if (["BUY", "INCOME", "TRANSFER_IN"].includes(tx.type)) {
        lots.push({ acquiredAt: tx.date, asset: tx.asset, quantity: tx.quantity, remainingQuantity: tx.quantity, totalCostEur: grossValue + (tx.type === "BUY" ? tx.feeEur : 0), txId: tx.txId });
        if (tx.type === "INCOME") income.push({ date: tx.date.toISOString(), asset: tx.asset, quantity: quantity(tx.quantity), value_eur: money(grossValue), tx_id: tx.txId, note: tx.note });
        continue;
      }
      if (tx.type === "TRANSFER_OUT") continue;
      if (tx.type !== "SELL") throw new Error(`Transaktionstyp ${tx.type} wird nicht unterstützt.`);

      let remainingToSell = tx.quantity;
      const sellProceedsTotal = grossValue - tx.feeEur;
      while (remainingToSell > 1e-12) {
        const lot = lots.find((candidate) => candidate.remainingQuantity > 1e-12);
        if (!lot) throw new Error(`Nicht genug offene Menge für Verkauf ${tx.txId} (${tx.asset}).`);
        const disposed = Math.min(remainingToSell, lot.remainingQuantity);
        const proceeds = sellProceedsTotal * (disposed / tx.quantity);
        const costBasis = lot.totalCostEur * (disposed / lot.quantity);
        const holdingDays = Math.floor((tx.date - lot.acquiredAt) / 86_400_000);
        realizedGains.push({
          sale_date: tx.date.toISOString(),
          acquired_date: lot.acquiredAt.toISOString(),
          asset: tx.asset,
          quantity: quantity(disposed),
          proceeds_eur: money(proceeds),
          cost_basis_eur: money(costBasis),
          gain_loss_eur: money(proceeds - costBasis),
          holding_days: String(holdingDays),
          holding_period_days_exceeded: String(holdingDays > holdingPeriodDays),
          buy_tx_id: lot.txId,
          sell_tx_id: tx.txId,
          note: tx.note,
        });
        lot.remainingQuantity -= disposed;
        remainingToSell -= disposed;
      }
    }

    return { realized_gains: realizedGains, income, fees };
  }

  function isoDate(value) {
    return new Date(value).toISOString().slice(0, 10);
  }

  const WISO_COLUMNS = [
    "Bereich",
    "Bezeichnung",
    "Asset",
    "Menge",
    "Anschaffungsdatum",
    "Veraeusserungsdatum",
    "Veraeusserungspreis_EUR",
    "Anschaffungskosten_EUR",
    "Aufwendungen_EUR",
    "Gewinn_Verlust_EUR",
    "Einnahmen_EUR",
    "Notiz",
  ];

  function buildWisoRows(outputs, taxYear = "") {
    const year = taxYear ? Number(taxYear) : null;
    const rows = [];
    for (const realized of outputs.realized_gains) {
      const saleDate = isoDate(realized.sale_date);
      if (year && Number(saleDate.slice(0, 4)) !== year) continue;
      if (realized.holding_period_days_exceeded === "true") continue;
      rows.push({
        Bereich: "Private Veraeusserungsgeschaefte (§ 23 EStG)",
        Bezeichnung: `Kryptowaehrung ${realized.asset}`,
        Asset: realized.asset,
        Menge: realized.quantity,
        Anschaffungsdatum: isoDate(realized.acquired_date),
        Veraeusserungsdatum: saleDate,
        Veraeusserungspreis_EUR: germanMoney(realized.proceeds_eur),
        Anschaffungskosten_EUR: germanMoney(realized.cost_basis_eur),
        Aufwendungen_EUR: "0,00",
        Gewinn_Verlust_EUR: germanMoney(realized.gain_loss_eur),
        Einnahmen_EUR: "",
        Notiz: `FIFO; Kauf ${realized.buy_tx_id}; Verkauf ${realized.sell_tx_id}; ${realized.note}`.trim(),
      });
    }
    for (const item of outputs.income) {
      const incomeDate = isoDate(item.date);
      if (year && Number(incomeDate.slice(0, 4)) !== year) continue;
      let note = `${item.tx_id}; ${item.note}`.trim();
      if (Number(item.value_eur) === 0) note = `${note}; EUR-Wert fehlt und muss in WISO geprueft werden`;
      rows.push({
        Bereich: "Leistungen (§ 22 Nr. 3 EStG)",
        Bezeichnung: `Krypto-Ertrag ${item.asset}`,
        Asset: item.asset,
        Menge: item.quantity,
        Anschaffungsdatum: incomeDate,
        Veraeusserungsdatum: "",
        Veraeusserungspreis_EUR: "",
        Anschaffungskosten_EUR: "",
        Aufwendungen_EUR: "0,00",
        Gewinn_Verlust_EUR: "",
        Einnahmen_EUR: germanMoney(item.value_eur),
        Notiz: note,
      });
    }
    return rows;
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    return /[";\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function toWisoCsv(rows) {
    const lines = [WISO_COLUMNS.join(";")];
    for (const row of rows) lines.push(WISO_COLUMNS.map((column) => csvEscape(row[column])).join(";"));
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  function makeProgressReporter(onProgress) {
    return (percent, label) => {
      if (typeof onProgress === "function") onProgress({ percent, label });
    };
  }

  function waitForProgressPaint() {
    return new Promise((resolve) => {
      if (typeof global.requestAnimationFrame === "function") {
        global.requestAnimationFrame(() => global.setTimeout(resolve, 0));
      } else {
        global.setTimeout(resolve, 0);
      }
    });
  }

  function createWisoCsvFromText(text, { source = "auto", taxYear = "", holdingPeriodDays = 365, onProgress = null } = {}) {
    const reportProgress = makeProgressReporter(onProgress);
    reportProgress(45, "Transaktionen werden gelesen");
    const transactions = readTransactions(text, source);
    reportProgress(65, "FIFO wird berechnet");
    const outputs = processTransactions(transactions, Number(holdingPeriodDays));
    reportProgress(80, "WISO-Zeilen werden erstellt");
    const rows = buildWisoRows(outputs, taxYear);
    reportProgress(88, "CSV wird geschrieben");
    return { csv: toWisoCsv(rows), rowCount: rows.length, transactionCount: transactions.length };
  }

  async function createWisoCsvFromTextAsync(text, { source = "auto", taxYear = "", holdingPeriodDays = 365, onProgress = null } = {}) {
    const reportProgress = makeProgressReporter(onProgress);
    reportProgress(45, "Transaktionen werden gelesen");
    await waitForProgressPaint();
    const transactions = readTransactions(text, source);
    reportProgress(65, "FIFO wird berechnet");
    await waitForProgressPaint();
    const outputs = processTransactions(transactions, Number(holdingPeriodDays));
    reportProgress(80, "WISO-Zeilen werden erstellt");
    await waitForProgressPaint();
    const rows = buildWisoRows(outputs, taxYear);
    reportProgress(88, "CSV wird geschrieben");
    await waitForProgressPaint();
    return { csv: toWisoCsv(rows), rowCount: rows.length, transactionCount: transactions.length };
  }

  global.CryptoTaxPrep = {
    readTransactions,
    processTransactions,
    buildWisoRows,
    toWisoCsv,
    createWisoCsvFromText,
    createWisoCsvFromTextAsync,
  };
})(globalThis);
