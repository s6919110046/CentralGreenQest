/**
 * CENTRAL GREEN QUEST — Google Sheets Reporting Backend
 *
 * 1) สร้าง Google Sheets
 * 2) Extensions > Apps Script
 * 3) วางโค้ดนี้ใน Code.gs
 * 4) ใส่ Spreadsheet ID
 * 5) Run setupSheets()
 * 6) Deploy เป็น Web app
 * 7) นำ URL /exec ไปใส่ใน config.js
 */

const SPREADSHEET_ID = "PUT_YOUR_GOOGLE_SHEET_ID_HERE";
const ALLOW_DUPLICATE_EMPLOYEE_ID = false;

const PARTICIPANTS_SHEET = "Participants";
const EVENTS_SHEET = "Game Events";
const DASHBOARD_SHEET = "Dashboard";

const PARTICIPANT_HEADERS = [
  "Session ID", "Registered At", "First Name", "Surname",
  "Employee ID", "Branch", "Telephone", "Sustainability Idea",
  "Registration Status", "Game 1 Score", "Game 1 Correct",
  "Game 1 Wrong / Missed", "Game 1 Status", "Game 1 Completed At",
  "Game 2 Score", "Game 2 Correct", "Game 2 Status",
  "Game 2 Completed At", "Total Score", "Last Activity",
  "The1 Reward Status", "Admin Notes"
];

const EVENT_HEADERS = [
  "Event ID", "Timestamp", "Session ID", "Employee ID", "Game",
  "Item ID", "Item Name", "Selected Bin", "Correct Bin",
  "Event Type", "Correct", "Server Points", "Attempt Number"
];

const ANSWER_KEY = {
  tissue: { name: "กระดาษทิชชู่", bin: "general" },
  food_box: { name: "กล่องใส่อาหารเปื้อน", bin: "burnable" },
  bubble_tea: { name: "แก้วชาไข่มุก", bin: "general" },
  wrappers: { name: "ซองขนม / ซองเครื่องปรุง", bin: "burnable" },
  curry_bag: { name: "ถุงแกงเปื้อนอาหาร", bin: "burnable" },
  utensils: { name: "ช้อนส้อมพลาสติก", bin: "burnable" },
  plastic_bag: { name: "ถุงพลาสติก", bin: "burnable" },
  plastic_bottle: { name: "ขวดน้ำพลาสติก", bin: "recycle" },
  batteries: { name: "ถ่านอัลคาไลน์", bin: "hazardous" },
  food_scraps: { name: "เศษอาหาร", bin: "organic" }
};

function doGet() {
  return jsonResponse_({
    ok: true,
    service: "Central Green Quest Reporting",
    timestamp: new Date().toISOString()
  });
}

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    const action = String(payload.action || "").trim();

    if (action === "health") {
      return jsonResponse_({ ok: true, service: "Central Green Quest Reporting" });
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);

    try {
      setupSheets();

      if (action === "register") {
        return jsonResponse_(registerParticipant_(payload));
      }

      if (action === "answer") {
        return jsonResponse_(recordAnswer_(payload));
      }

      if (action === "complete") {
        return jsonResponse_(completeGame_(payload));
      }

      return jsonResponse_({ ok: false, message: "Unknown action" });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return jsonResponse_({
      ok: false,
      message: error && error.message ? error.message : String(error)
    });
  }
}

function setupSheets() {
  const ss = getSpreadsheet_();

  let participants = ss.getSheetByName(PARTICIPANTS_SHEET);
  if (!participants) participants = ss.insertSheet(PARTICIPANTS_SHEET);

  let events = ss.getSheetByName(EVENTS_SHEET);
  if (!events) events = ss.insertSheet(EVENTS_SHEET);

  let dashboard = ss.getSheetByName(DASHBOARD_SHEET);
  if (!dashboard) dashboard = ss.insertSheet(DASHBOARD_SHEET);

  ensureHeaders_(participants, PARTICIPANT_HEADERS);
  ensureHeaders_(events, EVENT_HEADERS);
  setupParticipantFormatting_(participants);
  setupEventFormatting_(events);
  setupDashboard_(dashboard);
}

function registerParticipant_(data) {
  const firstName = cleanText_(data.firstName, 60);
  const surname = cleanText_(data.surname, 60);
  const employeeId = cleanText_(data.employeeId, 30);
  const branch = cleanText_(data.branch, 100);
  const phone = String(data.phone || "").replace(/\D/g, "");
  const idea = cleanText_(data.sustainabilityIdea, 500);

  if (!firstName) throw new Error("First name is required");
  if (!surname) throw new Error("Surname is required");
  if (!employeeId) throw new Error("Employee ID is required");
  if (!branch) throw new Error("Branch is required");
  if (phone.length < 9 || phone.length > 10) {
    throw new Error("Telephone number must contain 9–10 digits");
  }
  if (!idea) throw new Error("Sustainability idea is required");

  const sheet = getSpreadsheet_().getSheetByName(PARTICIPANTS_SHEET);

  if (!ALLOW_DUPLICATE_EMPLOYEE_ID) {
    const duplicate = findParticipantByEmployeeId_(sheet, employeeId);
    if (duplicate) {
      throw new Error("รหัสพนักงานนี้ลงทะเบียนแล้ว กรุณาติดต่อผู้ดูแลกิจกรรม");
    }
  }

  const sessionId = createSessionId_();
  const now = new Date();

  sheet.appendRow([
    sessionId, now, firstName, surname, employeeId, branch, phone, idea,
    "Registered", 0, 0, 0, "Not Started", "", 0, 0,
    "Not Started", "", 0, now, "Pending", ""
  ]);

  return { ok: true, sessionId, message: "Registered successfully" };
}

function recordAnswer_(data) {
  const sessionId = cleanText_(data.sessionId, 100);
  const clientEventId = cleanText_(data.clientEventId, 150);
  const game = cleanText_(data.game, 20);
  const itemId = cleanText_(data.itemId, 50);
  const selectedBin = cleanText_(data.selectedBin, 30);
  const eventType = cleanText_(data.eventType, 20) || "answer";

  if (!sessionId) throw new Error("Session ID is required");
  if (!clientEventId) throw new Error("Event ID is required");
  if (!["game1", "game2"].includes(game)) throw new Error("Invalid game");
  if (!ANSWER_KEY[itemId]) throw new Error("Invalid waste item");

  const ss = getSpreadsheet_();
  const participants = ss.getSheetByName(PARTICIPANTS_SHEET);
  const events = ss.getSheetByName(EVENTS_SHEET);
  const participant = findParticipantBySession_(participants, sessionId);

  if (!participant) throw new Error("Session not found");

  if (findEventById_(events, clientEventId)) {
    return { ok: true, duplicate: true, message: "Event already recorded" };
  }

  const previousEvents = getEventsForSessionGame_(events, sessionId, game);
  const answer = ANSWER_KEY[itemId];
  const priorItemEvents = previousEvents.filter(row => row.itemId === itemId);
  const priorCorrect = priorItemEvents.some(row => row.correct === true);

  if (game === "game2" && priorItemEvents.length > 0) {
    return {
      ok: true,
      duplicate: true,
      message: "This quiz item has already been answered"
    };
  }

  const isCorrect = eventType !== "miss" && selectedBin === answer.bin;
  let serverPoints = 0;

  if (game === "game1") {
    if (isCorrect && !priorCorrect) serverPoints = 10;
    else if (!isCorrect && eventType === "answer") serverPoints = -5;
  } else {
    serverPoints = isCorrect ? 10 : 0;
  }

  const attemptNumber = priorItemEvents.length + 1;
  const now = new Date();

  events.appendRow([
    clientEventId, now, sessionId, participant.employeeId, game,
    itemId, answer.name, selectedBin, answer.bin, eventType,
    isCorrect, serverPoints, attemptNumber
  ]);

  const summary = calculateGameSummary_(events, sessionId, game);
  updateParticipantGameSummary_(
    participants, participant.row, game, summary, now
  );

  return {
    ok: true,
    correct: isCorrect,
    correctBin: answer.bin,
    serverPoints,
    summary
  };
}

function completeGame_(data) {
  const sessionId = cleanText_(data.sessionId, 100);
  const game = cleanText_(data.game, 20);

  if (!sessionId) throw new Error("Session ID is required");
  if (!["game1", "game2"].includes(game)) throw new Error("Invalid game");

  const ss = getSpreadsheet_();
  const participants = ss.getSheetByName(PARTICIPANTS_SHEET);
  const events = ss.getSheetByName(EVENTS_SHEET);
  const participant = findParticipantBySession_(participants, sessionId);

  if (!participant) throw new Error("Session not found");

  const summary = calculateGameSummary_(events, sessionId, game);
  updateParticipantGameSummary_(
    participants, participant.row, game, summary, new Date()
  );

  return { ok: true, summary };
}

function calculateGameSummary_(eventsSheet, sessionId, game) {
  const rows = getEventsForSessionGame_(eventsSheet, sessionId, game);

  if (game === "game1") {
    const correctItems = {};
    let score = 0;
    let wrongOrMissed = 0;

    rows.forEach(row => {
      if (row.correct && !correctItems[row.itemId]) {
        correctItems[row.itemId] = true;
        score += 10;
      } else if (!row.correct) {
        wrongOrMissed += 1;
        if (row.eventType === "answer") {
          score = Math.max(0, score - 5);
        }
      }
    });

    const correctCount = Object.keys(correctItems).length;

    return {
      score,
      correctCount,
      wrongOrMissed,
      answeredCount: rows.length,
      completed: correctCount === Object.keys(ANSWER_KEY).length
    };
  }

  const answeredItems = {};
  let correctCount = 0;

  rows.forEach(row => {
    if (answeredItems[row.itemId]) return;
    answeredItems[row.itemId] = true;
    if (row.correct) correctCount += 1;
  });

  const answeredCount = Object.keys(answeredItems).length;

  return {
    score: correctCount * 10,
    correctCount,
    wrongOrMissed: answeredCount - correctCount,
    answeredCount,
    completed: answeredCount === Object.keys(ANSWER_KEY).length
  };
}

function updateParticipantGameSummary_(sheet, row, game, summary, now) {
  if (game === "game1") {
    sheet.getRange(row, 10).setValue(summary.score);
    sheet.getRange(row, 11).setValue(summary.correctCount);
    sheet.getRange(row, 12).setValue(summary.wrongOrMissed);
    sheet.getRange(row, 13).setValue(
      summary.completed ? "Completed" : "In Progress"
    );
    if (summary.completed) sheet.getRange(row, 14).setValue(now);
  } else {
    sheet.getRange(row, 15).setValue(summary.score);
    sheet.getRange(row, 16).setValue(summary.correctCount);
    sheet.getRange(row, 17).setValue(
      summary.completed ? "Completed" : "In Progress"
    );
    if (summary.completed) sheet.getRange(row, 18).setValue(now);
  }

  const game1Score = Number(sheet.getRange(row, 10).getValue()) || 0;
  const game2Score = Number(sheet.getRange(row, 15).getValue()) || 0;
  const game1Status = String(sheet.getRange(row, 13).getValue());
  const game2Status = String(sheet.getRange(row, 17).getValue());

  sheet.getRange(row, 19).setValue(game1Score + game2Score);
  sheet.getRange(row, 20).setValue(now);
  sheet.getRange(row, 9).setValue(
    game1Status === "Completed" && game2Status === "Completed"
      ? "Completed"
      : "Participating"
  );
}

function getEventsForSessionGame_(sheet, sessionId, game) {
  if (sheet.getLastRow() < 2) return [];

  const values = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, EVENT_HEADERS.length)
    .getValues();

  return values
    .filter(row => row[2] === sessionId && row[4] === game)
    .map(row => ({
      eventId: String(row[0]),
      itemId: String(row[5]),
      eventType: String(row[9]),
      correct: row[10] === true,
      serverPoints: Number(row[11]) || 0
    }));
}

function findParticipantBySession_(sheet, sessionId) {
  if (sheet.getLastRow() < 2) return null;

  const values = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, PARTICIPANT_HEADERS.length)
    .getValues();

  for (let index = 0; index < values.length; index += 1) {
    if (String(values[index][0]) === sessionId) {
      return { row: index + 2, employeeId: String(values[index][4]) };
    }
  }
  return null;
}

function findParticipantByEmployeeId_(sheet, employeeId) {
  if (sheet.getLastRow() < 2) return null;

  const values = sheet
    .getRange(2, 5, sheet.getLastRow() - 1, 1)
    .getDisplayValues();

  for (let index = 0; index < values.length; index += 1) {
    if (String(values[index][0]).trim() === employeeId) {
      return { row: index + 2 };
    }
  }
  return null;
}

function findEventById_(sheet, eventId) {
  if (sheet.getLastRow() < 2) return null;

  const values = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 1)
    .getDisplayValues();

  for (let index = 0; index < values.length; index += 1) {
    if (String(values[index][0]) === eventId) {
      return { row: index + 2 };
    }
  }
  return null;
}

function setupParticipantFormatting_(sheet) {
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, PARTICIPANT_HEADERS.length)
    .setBackground("#176B3A")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold");

  sheet.getRange("B:B").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheet.getRange("N:N").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheet.getRange("R:R").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheet.getRange("T:T").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheet.getRange("G:G").setNumberFormat("@");
  sheet.getRange("E:E").setNumberFormat("@");
  sheet.autoResizeColumns(1, PARTICIPANT_HEADERS.length);
  sheet.setColumnWidth(8, 380);
}

function setupEventFormatting_(sheet) {
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, EVENT_HEADERS.length)
    .setBackground("#315A98")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold");

  sheet.getRange("B:B").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  sheet.autoResizeColumns(1, EVENT_HEADERS.length);
}

function setupDashboard_(sheet) {
  sheet.clear();

  sheet.getRange("A1:D1")
    .merge()
    .setValue("CENTRAL GREEN QUEST — REPORT DASHBOARD")
    .setBackground("#176B3A")
    .setFontColor("#FFFFFF")
    .setFontWeight("bold")
    .setFontSize(15)
    .setHorizontalAlignment("center");

  sheet.getRange("A3:B8").setValues([
    ["Metric", "Value"],
    ["Registered participants", "=MAX(COUNTA(Participants!A:A)-1,0)"],
    ["Game 1 completed", '=COUNTIF(Participants!M:M,"Completed")'],
    ["Game 2 completed", '=COUNTIF(Participants!Q:Q,"Completed")'],
    ["Completed both games", '=COUNTIF(Participants!I:I,"Completed")'],
    ["Average total score", '=IFERROR(AVERAGEIF(Participants!S:S,">0"),0)']
  ]);

  sheet.getRange("A3:B3")
    .setBackground("#DDEEDC")
    .setFontWeight("bold");

  sheet.getRange("D3:H3")
    .setValues([[
      "Branch", "Participants", "Average Game 1",
      "Average Game 2", "Average Total"
    ]])
    .setBackground("#DDEEDC")
    .setFontWeight("bold");

  sheet.getRange("D4").setFormula(
    `=QUERY(Participants!A2:S,"select F,count(A),avg(J),avg(O),avg(S) where F is not null group by F label count(A) 'Participants',avg(J) 'Average Game 1',avg(O) 'Average Game 2',avg(S) 'Average Total'",0)`
  );

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 8);
  sheet.setColumnWidth(1, 210);
  sheet.setColumnWidth(4, 190);
}

function ensureHeaders_(sheet, headers) {
  const current = sheet
    .getRange(1, 1, 1, headers.length)
    .getDisplayValues()[0];

  const needsHeaders = headers.some(
    (header, index) => current[index] !== header
  );

  if (needsHeaders) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

function createSessionId_() {
  const date = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    "yyyyMMdd"
  );

  return `CGQ-${date}-${Utilities.getUuid()
    .replace(/-/g, "")
    .slice(0, 10)
    .toUpperCase()}`;
}

function cleanText_(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function getSpreadsheet_() {
  if (
    !SPREADSHEET_ID ||
    SPREADSHEET_ID === "PUT_YOUR_GOOGLE_SHEET_ID_HERE"
  ) {
    throw new Error("กรุณาใส่ Spreadsheet ID ใน Code.gs ก่อนใช้งาน");
  }

  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  return JSON.parse(e.postData.contents);
}

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Central Green Quest")
    .addItem("Setup / Refresh Sheets", "setupSheets")
    .addToUi();
}
