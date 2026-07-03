const siteUrlInput = document.querySelector("#siteUrl");
const boardIdsInput = document.querySelector("#boardIds");
const runButton = document.querySelector("#run");
const copyButton = document.querySelector("#copy");
const copyDebugButton = document.querySelector("#copyDebug");
const statusEl = document.querySelector("#status");
const outputEl = document.querySelector("#output");
const debugLogEl = document.querySelector("#debugLog");

const SPRINT_FIELD_ID = "customfield_10020";
const OPEN_SPRINT_JQL = "cf[10020] in openSprints()";

const JIRA_FIELDS = [
  "summary",
  "status",
  "assignee",
  "priority",
  "issuetype",
  "updated",
  "description",
  "parent",
  SPRINT_FIELD_ID
].join(",");

let epicFieldIds = null;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = new URL(tab?.url || "https://gofin.atlassian.net");
  if (url.hostname.endsWith(".atlassian.net")) {
    siteUrlInput.value = `${url.protocol}//${url.hostname}`;
  } else {
    siteUrlInput.value = "https://gofin.atlassian.net";
  }
  boardIdsInput.value = localStorage.getItem("boardIds") || "194,374";
}

runButton.addEventListener("click", async () => {
  const siteUrl = siteUrlInput.value.replace(/\/$/, "");
  const boardIds = boardIdsInput.value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  localStorage.setItem("boardIds", boardIds.join(","));

  outputEl.value = "";
  debugLogEl.value = "";
  copyButton.disabled = true;
  copyDebugButton.disabled = true;
  setBusy(true, "Fetching current sprint Jira data...");

  let debug = [];
  try {
    debug = createDebugLog(siteUrl, boardIds);
    const issuesByKey = new Map();
    for (const boardId of boardIds) {
      statusEl.textContent = `Fetching active sprint for board ${boardId}...`;
      const activeIssues = await fetchCurrentSprintIssues(siteUrl, boardId, debug);
      for (const issue of activeIssues) {
        if (isDoneIssue(issue)) {
          debugIssue(debug, "skip-done", issue);
          continue;
        }
        debugIssue(debug, "include-candidate", issue);
        issuesByKey.set(issue.key, issue);
      }
    }

    const issues = [...issuesByKey.values()];
    debug.push("");
    debug.push(`Unique issues selected for comment fetch: ${issues.length}`);
    debug.push(`Selected keys: ${issues.map((issue) => issue.key).join(", ") || "(none)"}`);

    const rows = [];
    for (let index = 0; index < issues.length; index += 1) {
      const issue = issues[index];
      statusEl.textContent = `Fetching comments ${index + 1}/${issues.length}: ${issue.key}`;
      const comments = await fetchAll(`${siteUrl}/rest/api/3/issue/${issue.key}/comment`, "comments");
      debugIssue(debug, `comment-fetch ${index + 1}/${issues.length}`, issue, {
        commentCount: comments.length,
        latestCommentCreated: latestComment(comments)?.created || ""
      });
      rows.push(await toSummaryRow(issue, latestComment(comments), siteUrl));
    }

    const rowsWithComments = rows.filter((row) => row.latestText);
    outputEl.value = toMarkdown(rowsWithComments);
    debug.push("");
    debug.push(`Rows with comments in summary: ${rowsWithComments.length}/${rows.length}`);
    debugLogEl.value = debug.join("\n");
    copyButton.disabled = rowsWithComments.length === 0;
    copyDebugButton.disabled = debugLogEl.value.length === 0;
    statusEl.textContent = `Done. ${rowsWithComments.length}/${rows.length} issues had a comment.`;
  } catch (error) {
    statusEl.textContent = "Failed.";
    outputEl.value = String(error?.message || error);
    debug.push("");
    debug.push(`ERROR: ${String(error?.message || error)}`);
    debugLogEl.value = debug.join("\n");
    copyDebugButton.disabled = debugLogEl.value.length === 0;
  } finally {
    setBusy(false);
  }
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(outputEl.value);
  statusEl.textContent = "Copied.";
});

copyDebugButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(debugLogEl.value);
  statusEl.textContent = "Copied debug log.";
});

async function fetchCurrentSprintIssues(siteUrl, boardId, debug) {
  const sprintUrl = `${siteUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active`;
  const sprints = await fetchAll(sprintUrl, "values");
  debug.push("");
  debug.push(`Board ${boardId}: active sprint lookup`);
  debug.push(`Sprint URL: ${sprintUrl}`);
  debug.push(`Active sprints (${sprints.length}): ${sprints.map(formatSprint).join(" | ") || "(none)"}`);
  if (sprints.length === 0) return [];

  const byKey = new Map();
  for (const sprint of sprints) {
    const issueUrl = `${siteUrl}/rest/agile/1.0/sprint/${sprint.id}/issue?fields=${encodeURIComponent(JIRA_FIELDS)}&jql=${encodeURIComponent(OPEN_SPRINT_JQL)}`;
    debug.push("");
    debug.push(`Board ${boardId}: fetching issues for ${formatSprint(sprint)}`);
    debug.push(`Issue URL: ${issueUrl}`);
    const issues = await fetchAll(issueUrl, "issues");
    debug.push(`Fetched ${issues.length} issues for sprint ${sprint.id}: ${issues.map((issue) => issue.key).join(", ") || "(none)"}`);
    for (const issue of issues) {
      debugIssue(debug, `sprint ${sprint.id}`, issue);
      byKey.set(issue.key, issue);
    }
  }
  return [...byKey.values()];
}

function createDebugLog(siteUrl, boardIds) {
  return [
    `Run time: ${new Date().toISOString()}`,
    `Site URL: ${siteUrl}`,
    `Board IDs: ${boardIds.join(", ")}`,
    `Fields: ${JIRA_FIELDS}`,
    `Open sprint JQL: ${OPEN_SPRINT_JQL}`
  ];
}

function debugIssue(debug, context, issue, extra = {}) {
  const fields = issue.fields || {};
  const status = fields.status?.name || "";
  const statusCategory = fields.status?.statusCategory?.name || "";
  const sprintValues = normalizeSprintDebugValues(fields[SPRINT_FIELD_ID]);
  const parent = fields.parent?.key || "";
  debug.push([
    `${context}: ${issue.key}`,
    `summary=${fields.summary || "(empty)"}`,
    `status=${status || "(empty)"}`,
    `statusCategory=${statusCategory || "(empty)"}`,
    `parent=${parent || "(empty)"}`,
    `sprints=${sprintValues || "(empty)"}`,
    ...Object.entries(extra).map(([key, value]) => `${key}=${value || "(empty)"}`)
  ].join(" | "));
}

function isDoneIssue(issue) {
  return issue.fields?.status?.statusCategory?.key === "done"
    || issue.fields?.status?.statusCategory?.name?.toLowerCase() === "done";
}

function normalizeSprintDebugValues(value) {
  if (!value) return "";
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return String(item);
    const id = item.id || "";
    const name = item.name || "";
    const state = item.state || "";
    return [id && `id:${id}`, name && `name:${name}`, state && `state:${state}`].filter(Boolean).join("/");
  }).join("; ");
}

function formatSprint(sprint) {
  return [
    `id=${sprint.id}`,
    `name=${sprint.name || ""}`,
    `state=${sprint.state || ""}`,
    `originBoardId=${sprint.originBoardId || ""}`,
    `start=${sprint.startDate || ""}`,
    `end=${sprint.endDate || ""}`
  ].join(",");
}

async function fetchAll(baseUrl, valuesKey) {
  const items = [];
  let startAt = 0;
  const maxResults = 50;

  while (true) {
    const url = new URL(baseUrl);
    url.searchParams.set("startAt", String(startAt));
    url.searchParams.set("maxResults", String(maxResults));

    const response = await fetch(url.toString(), {
      credentials: "include",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${response.statusText} for ${url}\n${text.slice(0, 500)}`);
    }

    const data = await response.json();
    const pageItems = data[valuesKey] || [];
    items.push(...pageItems);

    startAt = Number(data.startAt || startAt) + pageItems.length;
    if (data.isLast === true || pageItems.length === 0 || (data.total != null && startAt >= Number(data.total))) {
      break;
    }
  }

  return items;
}

function latestComment(comments) {
  if (!comments.length) return null;
  return comments.reduce((latest, comment) => {
    return new Date(comment.created) > new Date(latest.created) ? comment : latest;
  });
}

async function toSummaryRow(issue, comment, siteUrl) {
  const fields = issue.fields || {};
  const latestText = comment ? adfToText(comment.body) : "";
  const description = adfToText(fields.description);
  const status = fields.status?.name || "";
  const epic = await getEpic(siteUrl, issue);

  return {
    key: issue.key,
    url: `${siteUrl}/browse/${issue.key}`,
    title: fields.summary || "",
    status,
    assignee: fields.assignee?.displayName || "Unassigned",
    priority: fields.priority?.name || "",
    updated: fields.updated || "",
    latestAuthor: comment?.author?.displayName || "",
    latestCreated: comment?.created || "",
    latestText,
    epicKey: epic.key,
    epicTitle: epic.title,
    summary: latestText
      ? `${fields.summary || ""} | Status: ${status} | Latest: ${latestText.slice(0, 240)}`
      : `${fields.summary || ""} | Status: ${status} | Description: ${description.slice(0, 240)}`
  };
}

function toMarkdown(rows) {
  const lines = [];
  const groups = new Map();

  for (const row of rows) {
    const epicLabel = row.epicKey
      ? `${row.epicKey}${row.epicTitle ? ` ${row.epicTitle}` : ""}`
      : "No Epic";
    if (!groups.has(epicLabel)) groups.set(epicLabel, []);
    groups.get(epicLabel).push(row);
  }

  let itemNumber = 0;
  for (const [epicLabel, epicRows] of groups.entries()) {
    if (epicLabel === "No Epic") {
      for (const row of epicRows) {
        itemNumber += 1;
        lines.push(`${itemNumber}. [${row.key}]-${row.title}: ${row.latestText}`);
        lines.push("");
      }
    } else {
      itemNumber += 1;
      lines.push(`${itemNumber}. Epic: ${epicLabel}`);
      for (const row of epicRows) {
        lines.push(`- ${row.title}: ${row.latestText}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

async function getEpic(siteUrl, issue) {
  const fields = issue.fields || {};
  if (fields.parent?.fields?.issuetype?.name?.toLowerCase() === "epic") {
    return {
      key: fields.parent.key || "",
      title: fields.parent.fields?.summary || ""
    };
  }

  const ids = await getEpicFieldIds(siteUrl);
  for (const id of ids) {
    const value = fields[id];
    const epic = normalizeEpicValue(value);
    if (epic.key || epic.title) return epic;
  }

  return { key: "", title: "" };
}

async function getEpicFieldIds(siteUrl) {
  if (epicFieldIds) return epicFieldIds;

  const response = await fetch(`${siteUrl}/rest/api/3/field`, {
    credentials: "include",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    epicFieldIds = [];
    return epicFieldIds;
  }

  const fields = await response.json();
  epicFieldIds = fields
    .filter((field) => {
      const name = String(field.name || "").toLowerCase();
      const key = String(field.key || "").toLowerCase();
      return name.includes("epic") || key.includes("epic");
    })
    .map((field) => field.id)
    .filter(Boolean);
  return epicFieldIds;
}

function normalizeEpicValue(value) {
  if (!value) return { key: "", title: "" };
  if (typeof value === "string") return { key: value, title: "" };
  if (typeof value === "object") {
    return {
      key: value.key || value.name || "",
      title: value.summary || value.title || value.value || ""
    };
  }
  return { key: String(value), title: "" };
}

function adfToText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(adfToText).filter(Boolean).join(" ");
  if (typeof value === "object") {
    const parts = [];
    if (value.text) parts.push(value.text);
    if (value.content) parts.push(adfToText(value.content));
    return parts.join(" ").trim();
  }
  return String(value);
}

function setBusy(isBusy, message = "") {
  runButton.disabled = isBusy;
  if (message) statusEl.textContent = message;
}
