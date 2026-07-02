# Jira Sprint Summarizer Extension

Chrome extension that uses your logged-in Jira browser session.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this folder: `jira-summary-extension`.

## Use

1. Log in to Jira in the same Chrome profile.
2. Open any `https://gofin.atlassian.net` page.
3. Click the extension.
4. Use board IDs `194,374`.
5. Click Summarize.

The extension calls:

- `/rest/agile/1.0/board/{boardId}/sprint?state=active`
- `/rest/agile/1.0/sprint/{sprintId}/issue`
- `/rest/api/3/issue/{issueKey}/comment`

No API token needed.
